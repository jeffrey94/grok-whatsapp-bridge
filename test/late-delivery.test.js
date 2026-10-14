/**
 * Streaming delivery, reply timeouts and late (after-turn) agent messages.
 * Offline: an in-memory gateway behind GrokClient's fetchImpl and a fake
 * WhatsApp transport. Nothing contacts WhatsApp or the real gateway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERROR_NOTICE, WhatsAppBridge, chatFromNonce } from "../src/bridge.js";
import { LoopGuard } from "../src/core/loop-guard.js";
import { ChatRouter } from "../src/core/routing.js";
import { GrokClient } from "../src/grok-client.js";
import { JsonStateStore } from "../src/state.js";
import { recordingLog, waitFor } from "./helpers/fake-baileys.js";

const AGENT = "agent-test";
const OTHER_AGENT = "agent-other";
const GROUP = "120363000000000021@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const OWNER = "60123456789@s.whatsapp.net";
const SELF = "10111111111@s.whatsapp.net";

/** In-memory gateway. `status` is what listAgents reports for AGENT. */
function fakeGateway() {
  const gw = {
    entries: [],
    status: { isRunning: false, isRunningTurn: false, isComposingMessage: false },
    seq: 0,
    prompts: [],
    onPrompt: undefined,
    id(prefix) { gw.seq += 1; return `${prefix}${gw.seq}`; },
    reply(text, extra = {}) {
      const entry = { id: gw.id("s"), kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: text }, ...extra };
      gw.entries.push(entry);
      return entry;
    },
    desktopPrompt(text) {
      gw.entries.push({ id: gw.id("u"), kind: "message", role: "user", clientNonce: "desktop-uuid", content: text, timestampMs: Date.now() });
    },
  };
  const handlers = {
    listAgents: () => ({ agents: [{ id: AGENT, name: "Test", ...gw.status }, { id: OTHER_AGENT, name: "Other", isRunning: false }] }),
    sendPrompt: (body) => {
      gw.prompts.push(body);
      gw.entries.push({ id: gw.id("u"), kind: "message", role: "user", clientNonce: body.clientNonce, content: body.prompt, timestampMs: Date.now() });
      gw.onPrompt?.(body);
      return { accepted: true };
    },
    getAgentTranscriptTail: ({ id, limit }) => ({ entries: id === AGENT ? gw.entries.slice(-limit) : [] }),
    getAgentTranscript: ({ id }) => ({ entries: id === AGENT ? gw.entries : [] }),
  };
  gw.fetchImpl = async (url, init) => {
    const method = url.split("/api/")[1];
    const body = JSON.parse(init.body || "{}");
    const result = handlers[method]?.(body);
    return { ok: Boolean(handlers[method]), status: handlers[method] ? 200 : 404, json: async () => ({ result }) };
  };
  return gw;
}

function fakeTransport() {
  const sent = [];
  return {
    sent,
    selfIds: () => [SELF],
    sendText: async (chatId, text, options = {}) => { sent.push({ chatId, text, quoted: options.quoted?.key?.id }); return { id: `B${sent.length}` }; },
    sendFile: async (chatId, file) => { sent.push({ chatId, file: file.filename }); return { id: `B${sent.length}` }; },
    setTyping: async () => {},
    chatName: () => "Test Group",
  };
}

async function setup({ replyTimeoutMs = 5_000, groups, statePath, now, extraOptions = {} } = {}) {
  const dir = statePath ? path.dirname(statePath) : mkdtempSync(path.join(tmpdir(), "wa-late-"));
  const gw = fakeGateway();
  const state = new JsonStateStore(statePath ?? path.join(dir, "bridge-state.json"));
  await state.load();
  const router = new ChatRouter({
    defaultAgent: OTHER_AGENT,
    dms: [{ id: OWNER, agent: AGENT }],
    groups: groups ?? [
      { jid: GROUP, name: "Test Group", agent: AGENT, mode: "mention" },
      { jid: OTHER_GROUP, name: "Other", agent: OTHER_AGENT, mode: "mention" },
    ],
  });
  const log = recordingLog();
  const transport = fakeTransport();
  const grok = new GrokClient("http://127.0.0.1:1340", "t", { fetchImpl: gw.fetchImpl, pollIntervalMs: 10, replyTimeoutMs });
  const bridge = new WhatsAppBridge({
    grok, state, router, guard: new LoopGuard(), transport, log,
    options: { sendDelayMs: 0, stableReplyMs: 40, lateDeliveryPollMs: 10, typingIndicator: false, ...(now ? { now } : {}), ...extraOptions },
  });
  return { dir, gw, state, bridge, transport, log, statePath: state.filename };
}

let msgSeq = 0;
function mention(text, chatId = GROUP) {
  msgSeq += 1;
  return {
    id: `M${msgSeq}`,
    chatId,
    sender: { jid: "123456789012345@lid" },
    kind: "text",
    text: `@10111111111 ${text}`,
    mentionedJids: [SELF],
    timestamp: Math.floor(Date.now() / 1000),
    raw: { key: { id: `M${msgSeq}`, remoteJid: chatId } },
  };
}

const texts = (ctx) => ctx.transport.sent.map((item) => item.text);

test("chatFromNonce only accepts nonces this bridge created", () => {
  assert.equal(chatFromNonce(`whatsapp:${GROUP}:3EB0ABC`), GROUP);
  assert.equal(chatFromNonce(`whatsapp:${OWNER}:X:b3`), OWNER);
  assert.equal(chatFromNonce("telegram:123:4"), undefined);
  assert.equal(chatFromNonce("desktop-uuid"), undefined);
  assert.equal(chatFromNonce(undefined), undefined);
});

test("item 1+3: ack is delivered while the turn runs; turn ends when isRunningTurn goes false even though a background task keeps isRunning true", async () => {
  const ctx = await setup({ replyTimeoutMs: 10_000 });
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false };
    setTimeout(() => ctx.gw.reply("On it, running this in the background"), 20);
  };
  const started = Date.now();
  const done = ctx.bridge.handleEvent(mention("check the stock"));
  await waitFor(() => ctx.transport.sent.length === 1);
  assert.equal(ctx.gw.status.isRunningTurn, true, "delivered while the agent was still in its turn (streaming)");
  assert.equal(ctx.transport.sent[0].chatId, GROUP);
  assert.equal(ctx.transport.sent[0].quoted, `M${msgSeq}`, "first streamed part quotes the trigger");
  // The turn ends; a background subagent keeps the agent "running".
  ctx.gw.status = { isRunning: true, isRunningTurn: false, isComposingMessage: false };
  const result = await done;
  assert.equal(result.handled, "prompt");
  assert.ok(Date.now() - started < 3_000, "did not wait for the reply timeout");
  assert.deepEqual(texts(ctx), ["On it, running this in the background"], "delivered exactly once");
  assert.ok(ctx.log.lines.some((line) => /Delivered chat=120363000000000021@g\.us entry=s\d+ parts=1$/.test(line)));
});

test("item 1+3: several SendToUser messages stream out one by one in order", async () => {
  // Deterministic: each later message is only produced after the previous one was delivered,
  // so the test never depends on wall-clock gaps between replies (it used to flake under CI load).
  const ctx = await setup();
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true };
    ctx.gw.reply("one");
  };
  const done = ctx.bridge.handleEvent(mention("go"));
  await waitFor(() => ctx.transport.sent.length === 1);
  assert.deepEqual(texts(ctx), ["one"], "first message went out before the others existed");
  ctx.gw.reply("two");
  await waitFor(() => ctx.transport.sent.length === 2);
  assert.deepEqual(texts(ctx), ["one", "two"], "second message streamed out while the turn was still running");
  ctx.gw.reply("three");
  ctx.gw.status = { isRunning: false, isRunningTurn: false };
  await done;
  assert.deepEqual(texts(ctx), ["one", "two", "three"]);
  assert.equal(ctx.transport.sent[1].quoted, undefined, "only the first part is quoted");
  assert.equal(ctx.transport.sent[2].quoted, undefined, "only the first part is quoted");
});

test("item 1: legacy gateway (no isRunningTurn) timing out still delivers the ack, sends no error notice, and later messages are forwarded", async () => {
  const ctx = await setup({ replyTimeoutMs: 300 });
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isComposingMessage: false }; // never goes idle, no isRunningTurn
    setTimeout(() => ctx.gw.reply("ack: working on it"), 20);
  };
  const event = mention("long job");
  await ctx.bridge.ingest(event);
  assert.deepEqual(texts(ctx), ["ack: working on it"]);
  assert.equal(texts(ctx).includes(ERROR_NOTICE), false, "no error notice when the agent already answered");
  assert.ok(ctx.log.lines.some((line) => /Turn wait timed out chat=120363000000000021@g\.us delivered=1; later agent messages will still be forwarded/.test(line)));
  assert.equal(ctx.state.getPromptContext(AGENT, `whatsapp:${GROUP}:${event.id}`), undefined, "turn retired");

  // The background task finishes: the agent posts the result in a hidden turn (no prompt entry).
  ctx.gw.status = { isRunning: false };
  ctx.gw.reply("Result: 42 units in stock");
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["ack: working on it", "Result: 42 units in stock"]);
  assert.equal(ctx.transport.sent[1].chatId, GROUP);
  assert.ok(ctx.log.lines.some((line) => /Delivered chat=120363000000000021@g\.us entry=s\d+ parts=1 late=yes/.test(line)));
  // Polling again never duplicates anything.
  await ctx.bridge.pollLateOnce();
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.transport.sent.length, 2);
});

test("item 1: a timeout with nothing sent still posts the error notice", async () => {
  const ctx = await setup({ replyTimeoutMs: 200 });
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: true }; };
  await ctx.bridge.ingest(mention("silent long job"));
  assert.deepEqual(texts(ctx), [ERROR_NOTICE]);
});

test("item 2 (eff, followUpWindowMs=0): a finished turn is not followed: no transcript polls, and later unsolicited messages are not posted", async () => {
  const ctx = await setup({ extraOptions: { followUpWindowMs: 0 } });
  ctx.gw.onPrompt = () => { ctx.gw.reply("sure"); };
  await ctx.bridge.handleEvent(mention("hello"));
  assert.deepEqual(texts(ctx), ["sure"]);
  assert.equal(ctx.state.listLateTurns().length, 0, "answered turn is not pending");
  ctx.gw.reply("background result nobody asked to follow");
  const before = ctx.bridge.metrics.latePolls;
  await ctx.bridge.pollLateOnce();
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.bridge.metrics.latePolls, before, "no gateway poll without a pending turn");
  assert.deepEqual(texts(ctx), ["sure"]);
});

test("item 2 (followUpWindowMs=0): late reply of a pending (timed-out) turn follows its chat, survives a restart, never duplicates, and stops after it is answered", async () => {
  const first = await setup({ replyTimeoutMs: 200, extraOptions: { followUpWindowMs: 0 } });
  first.gw.onPrompt = () => { first.gw.status = { isRunning: true }; };
  const event = mention("start job");
  await first.bridge.ingest(event);
  assert.deepEqual(texts(first), [ERROR_NOTICE]);
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  assert.equal(first.state.getLateTurn(AGENT, nonce)?.reason, "timeout", "timed-out turn stays pending");

  // Restart: new bridge, same state file, same transcript.
  const second = await setup({ statePath: first.statePath, extraOptions: { followUpWindowMs: 0 } });
  second.gw.entries = first.gw.entries;
  second.gw.seq = first.gw.seq;
  await second.bridge.pollLateOnce();
  assert.equal(second.transport.sent.length, 0, "nothing re-sent after restart");
  second.gw.reply("final result");
  await second.bridge.pollLateOnce();
  await second.bridge.pollLateOnce();
  assert.deepEqual(texts(second), ["final result"]);
  assert.equal(second.transport.sent[0].chatId, GROUP);
  assert.equal(second.state.getLateTurn(AGENT, nonce), undefined, "answered -> no longer pending");
  second.gw.reply("an extra message after the answer");
  await second.bridge.pollLateOnce();
  assert.deepEqual(texts(second), ["final result"], "not followed after the answer");
});

test("item 2: a chat that is no longer configured for the agent never receives late messages", async () => {
  const first = await setup({ replyTimeoutMs: 200 });
  first.gw.onPrompt = () => { first.gw.status = { isRunning: true }; };
  await first.bridge.ingest(mention("start job"));

  // Restart with config where the group now belongs to another agent.
  const second = await setup({
    statePath: first.statePath,
    groups: [{ jid: GROUP, name: "Test Group", agent: OTHER_AGENT, mode: "mention" }],
  });
  second.gw.entries = first.gw.entries;
  second.gw.seq = first.gw.seq;
  second.gw.reply("result for a chat that moved");
  await second.bridge.pollLateOnce();
  assert.equal(second.transport.sent.length, 0);
  assert.ok(second.log.lines.some((line) => /Late message not delivered .*reason=chat-not-configured-for-agent/.test(line)));
});

test("item 2 (followUpWindowMs=0): the follower leaves an agent alone while its live turn is running (no double delivery, order kept)", async () => {
  const ctx = await setup({ extraOptions: { followUpWindowMs: 0 } });
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true };
    setTimeout(() => ctx.gw.reply("a"), 10);
    setTimeout(() => { ctx.gw.reply("b"); ctx.gw.status = { isRunning: false, isRunningTurn: false }; }, 150);
  };
  const lateLoop = new AbortController();
  const loop = ctx.bridge.runLateDelivery({ signal: lateLoop.signal });
  await ctx.bridge.handleEvent(mention("go"));
  ctx.gw.reply("c");
  await waitFor(() => ctx.transport.sent.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 80));
  lateLoop.abort();
  await loop;
  assert.deepEqual(texts(ctx), ["a", "b"], "finished turn: the unsolicited 'c' is not followed");
});

test("item 3: recovered turn after a restart does not resend entries delivered before it (legacy per-turn keys)", async () => {
  const ctx = await setup();
  const nonce = `whatsapp:${GROUP}:OLD1`;
  ctx.gw.entries.push({ id: "t3u", kind: "message", role: "user", clientNonce: nonce, timestampMs: Date.now() });
  ctx.gw.entries.push({ id: "t3s0", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "old ack" } });
  ctx.gw.entries.push({ id: "t3s1", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "new part" } });
  await ctx.state.completeDeliveryProgress(`wa:${AGENT}:${nonce}:t3s0`, { nextPart: 1 });
  await ctx.state.setPromptContext(AGENT, nonce, { contextKey: nonce, clientNonce: nonce, origin: "whatsapp", chatId: GROUP, createdAt: Date.now() - 15 * 60_000 });
  await ctx.bridge.recoverPending();
  assert.deepEqual(texts(ctx), ["new part"]);
});

test("freeze fix: a turn still waiting on the agent releases the agent queue after turnQueueHoldMs, so the next message is handled", async () => {
  const ctx = await setup({ replyTimeoutMs: 3_000 });
  ctx.bridge.options.turnQueueHoldMs = 150;
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false }; };
  const started = Date.now();
  const first = ctx.bridge.ingest(mention("long job"));
  // Arrives once the first turn is running (two at once would be one backlog batch).
  await waitFor(() => ctx.gw.prompts.length === 1, 2_000);
  const second = ctx.bridge.ingest(mention("quick question"));
  await waitFor(() => ctx.gw.prompts.length === 2, 2_000);
  assert.ok(Date.now() - started < 2_000, "second prompt did not wait for the first turn's reply timeout");
  assert.ok(ctx.log.lines.some((line) => /releasing the queue/.test(line)), "release was logged");
  ctx.gw.status = { isRunning: false, isRunningTurn: false, isComposingMessage: false };
  ctx.gw.reply("done");
  await Promise.allSettled([first, second]);
  await ctx.bridge.drain();
});

test("freeze fix: a hung typing-off presence update never holds the queue", async () => {
  const ctx = await setup({ replyTimeoutMs: 3_000 });
  ctx.bridge.options.typingIndicator = true;
  ctx.transport.setTyping = (_chat, on) => (on ? Promise.resolve() : new Promise(() => {}));
  ctx.gw.onPrompt = () => { setTimeout(() => ctx.gw.reply("hi"), 5); };
  await ctx.bridge.ingest(mention("one"));
  const result = await Promise.race([ctx.bridge.ingest(mention("two")), new Promise((r) => setTimeout(() => r("stuck"), 2_000))]);
  assert.notEqual(result, "stuck");
  assert.equal(ctx.gw.prompts.length, 2);
});

test("freeze fix: in-flight inbound messages are tracked for the watchdog and cleared when done", async () => {
  const ctx = await setup({ replyTimeoutMs: 3_000 });
  let release;
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false }; release = () => { ctx.gw.status = { isRunning: false, isRunningTurn: false, isComposingMessage: false }; ctx.gw.reply("ok"); }; };
  const task = ctx.bridge.ingest(mention("watch me"));
  await waitFor(() => ctx.gw.prompts.length === 1);
  assert.equal(ctx.bridge.inflight.size, 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ctx.bridge.oldestInflightMs() >= 20);
  release();
  await task;
  await waitFor(() => ctx.bridge.inflight.size === 0);
  assert.equal(ctx.bridge.oldestInflightMs(), 0);
});

test("10:14 regression: failed sends don't burn the rate budget, and a rate-limited reply waits for a slot instead of being dropped", async () => {
  const ctx = await setup({ replyTimeoutMs: 3_000 });
  ctx.bridge.guard = new LoopGuard({ outboundPerChatPerMinute: 2 });
  ctx.bridge.guard.openReplyWindow(GROUP);
  // Four sends fail on a closed socket (they must be refunded).
  let failures = 4;
  const realSend = ctx.transport.sendText;
  ctx.transport.sendText = async (...args) => { if (failures > 0) { failures -= 1; throw new Error("Connection Closed"); } return realSend(...args); };
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(ctx.bridge.deliverEntries({ id: AGENT }, undefined, [{ id: `f${i}`, kind: "send-message", message: { type: "text", content: "retry me" } }], { chatId: GROUP }));
  }
  assert.equal(ctx.bridge.guard.outboundBudget(GROUP), 2, "failed sends were refunded");
  // Budget 2, three replies: the third waits for a slot (short window in this test) rather than dropping.
  ctx.bridge.guard.outboundChat.windowMs = 300;
  ctx.bridge.options.rateWaitMaxMs = 2_000;
  const entries = ["a", "b", "c"].map((t, i) => ({ id: `r${i}`, kind: "send-message", message: { type: "text", content: t } }));
  await ctx.bridge.deliverEntries({ id: AGENT }, undefined, entries, { chatId: GROUP });
  assert.deepEqual(texts(ctx), ["a", "b", "c"]);
  assert.ok(!ctx.log.lines.some((line) => /Outbound dropped/.test(line)));
});

test("late-quote fix: a late reply quotes its own turn's message (by turn/nonce, persisted), never a newer batch; unknown turn -> no quote", async () => {
  const ctx = await setup();
  const now = Date.now();
  const nJ = `whatsapp:${GROUP}:QJEFF`;
  const nX = `whatsapp:${GROUP}:QOTHER`;
  const nB = `whatsapp:${GROUP}:QJAMES:batch2`;
  const agents = [{ id: AGENT, name: "Test" }, { id: OTHER_AGENT, name: "Other" }];
  for (const id of ["QJEFF", "QOTHER", "QJAMES"]) ctx.bridge.inboundRaw.set(id, { key: { id, remoteJid: GROUP } });
  await ctx.state.setTurnQuote(AGENT, nJ, { chatId: GROUP, msgId: "QJEFF" });
  await ctx.state.setTurnQuote(AGENT, nB, { chatId: GROUP, msgId: "QJAMES" });
  const prompt = (id, clientNonce) => ({ id, kind: "message", role: "user", clientNonce, content: "q", timestampMs: now });
  const reply = (id, content) => ({ id, kind: "send-message", timestampMs: now, message: { type: "text", content } });
  ctx.gw.entries.push(
    prompt("t310s654", nJ),
    prompt("t311s656", nX),
    prompt("t312s658", nB),
    reply("t310s655", "The developer is Tropicana"), // late, after the newer batch prompt
    reply("t309s653", "orphan from a turn not in view"),
  );
  await ctx.state.setMirrorCursor(AGENT, "t310s654");
  await ctx.state.setLateTurn(AGENT, nJ, { chatId: GROUP, sentAt: now, armedAt: now, reason: "timeout" });
  await ctx.bridge.followAgent(AGENT, { chatId: GROUP, at: now }, agents);
  assert.deepEqual(texts(ctx), ["The developer is Tropicana"], "orphan of an unknown turn is not posted (late guard)");
  assert.equal(ctx.transport.sent[0].quoted, "QJEFF", "quotes the question it answers");
  assert.ok(ctx.log.lines.some((line) => /Late message skipped .*entry=t309s653 reason=unknown-prompt/.test(line)));

  // The mapping is persisted alongside pending turns (survives reload / snapshot restore).
  const reloaded = new JsonStateStore(ctx.statePath);
  await reloaded.load();
  assert.equal(reloaded.getTurnQuote(AGENT, nJ)?.msgId, "QJEFF");
  assert.equal(ctx.bridge.quotedForNonce(GROUP, nB, AGENT)?.key?.id, "QJAMES");
  assert.equal(ctx.bridge.quotedForNonce(GROUP, undefined, AGENT), undefined);
});

// ---------- follow-up window: entries after end_turn ----------

test("follow-up: after a completed turn, a later SendToUser (background-completion wake) is delivered once, in order, quoting its own question", async () => {
  let clock = Date.now();
  const ctx = await setup({ now: () => clock });
  ctx.gw.onPrompt = () => { ctx.gw.reply("Looking now."); ctx.gw.reply("I'll post picks once checked."); };
  const event = mention("cheaper picks?");
  await ctx.bridge.handleEvent(event);
  assert.deepEqual(texts(ctx), ["Looking now.", "I'll post picks once checked."]);
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  assert.equal(ctx.state.getLateTurn(AGENT, nonce)?.followUp, true, "conversation is watched after the turn");
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.transport.sent.length, 2, "nothing replayed");
  ctx.gw.reply("Here are 3 picks");
  ctx.gw.reply("Want me to book one?");
  clock += 60_000;
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx).slice(2), ["Here are 3 picks", "Want me to book one?"]);
  assert.ok([undefined, event.id].includes(ctx.transport.sent[2].quoted), "late part: no quote or quotes its own question");
  assert.equal(ctx.transport.sent[3].quoted, undefined);
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.transport.sent.length, 4, "never duplicated");
});

test("follow-up: window extends on each new entry and closes after followUpWindowMs; idle polling backs off", async () => {
  let clock = Date.now();
  const ctx = await setup({ now: () => clock });
  ctx.gw.onPrompt = () => { ctx.gw.reply("ok"); };
  const event = mention("hi");
  await ctx.bridge.handleEvent(event);
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  const firstUntil = ctx.state.getLateTurn(AGENT, nonce).followUntil;
  // idle backoff: a second poll right away does not hit the gateway
  await ctx.bridge.pollLateOnce();
  const polls = ctx.bridge.metrics.latePolls;
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.bridge.metrics.latePolls, polls, "idle follow-up is backed off");
  assert.ok(ctx.bridge.followUpIdle.get(AGENT).nextAt - clock <= 30_000);
  clock += 8 * 60_000;
  ctx.gw.reply("late one");
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["ok", "late one"]);
  assert.ok(ctx.state.getLateTurn(AGENT, nonce).followUntil > firstUntil, "extended");
  clock += 9 * 60_000; // still inside the extended window
  ctx.gw.reply("later one");
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["ok", "late one", "later one"]);
  clock += 11 * 60_000;
  ctx.gw.reply("too late");
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.state.getLateTurn(AGENT, nonce), undefined, "window closed");
  assert.ok(ctx.log.lines.some((l) => /Follow-up window closed agent=agent-test/.test(l)));
  const before = ctx.bridge.metrics.latePolls;
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.bridge.metrics.latePolls, before, "no polling after the window");
  assert.equal(texts(ctx).includes("too late"), false);
});

test("follow-up: survives a restart without resending, then delivers the new entry once", async () => {
  const first = await setup();
  first.gw.onPrompt = () => { first.gw.reply("ack"); };
  await first.bridge.handleEvent(mention("go"));
  const second = await setup({ statePath: first.statePath });
  second.gw.entries = first.gw.entries;
  second.gw.seq = first.gw.seq;
  await second.bridge.pollLateOnce();
  assert.equal(second.transport.sent.length, 0, "ack not resent after restart");
  second.gw.reply("result after restart");
  second.bridge.followUpIdle.clear();
  await second.bridge.pollLateOnce();
  second.bridge.followUpIdle.clear();
  await second.bridge.pollLateOnce();
  assert.deepEqual(texts(second), ["result after restart"]);
});

test("follow-up: a late entry with the same text just sent to the chat is skipped (duplicate text guard)", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = () => { ctx.gw.reply("Here are the picks for Wednesday night"); };
  await ctx.bridge.handleEvent(mention("picks?"));
  ctx.gw.reply("Here are the picks for Wednesday night");
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["Here are the picks for Wednesday night"]);
  assert.ok(ctx.log.lines.some((l) => /Late duplicate text skipped/.test(l)));
});

test("follow-up: a faq-only sender's late entry still goes through the account-data backstop", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = () => { ctx.gw.reply("ok"); };
  const event = mention("price?");
  await ctx.bridge.handleEvent(event);
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  ctx.bridge.turnAccess.set(nonce, "faq-only");
  ctx.gw.reply("Invoice INV-2026-001 total RM 1,500.00");
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.equal(texts(ctx).some((t) => /INV-2026-001|1,500/.test(t ?? "")), false);
});

// ---------- batch2 ----------

function realStyle(ctx, nonce, turn, texts, { prompt = true, at = Date.now() } = {}) {
  if (prompt) ctx.gw.entries.push({ id: `t${turn}u`, kind: "message", role: "user", clientNonce: nonce, content: "q", timestampMs: at });
  texts.forEach((text, i) => ctx.gw.entries.push({ id: `t${turn}s${i}`, kind: "send-message", timestampMs: at, message: { type: "text", content: text } }));
}

test("batch2 #3: same-turn t20s2 and new-turn wake t21s0 (no WhatsApp prompt) both reach the open follow-up watch's chat, once", async () => {
  const ctx = await setup();
  const event = mention("cheaper picks?");
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  ctx.gw.onPrompt = (body) => {
    ctx.gw.entries.pop(); // replace the fake prompt with a real-style one
    realStyle(ctx, body.clientNonce, 20, ["Looking now.", "I'll post them here."]);
  };
  await ctx.bridge.handleEvent(event);
  assert.deepEqual(texts(ctx), ["Looking now.", "I'll post them here."]);
  realStyle(ctx, null, 20, [], { prompt: false });
  ctx.gw.entries.push({ id: "t20s2", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "Here are 3 picks at around 30 to 50 per person" } });
  ctx.gw.entries.push({ id: "t21u", kind: "message", role: "user", content: "[background task finished]", timestampMs: Date.now() }); // wake, no nonce
  ctx.gw.entries.push({ id: "t21s0", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "Also checked: all three are open on Wednesday" } });
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx).slice(2), ["Here are 3 picks at around 30 to 50 per person", "Also checked: all three are open on Wednesday"]);
  assert.ok(ctx.transport.sent.slice(2).every((m) => m.chatId === GROUP));
  assert.ok(ctx.log.lines.some((l) => /Late wake entry linked .*entry=t21s0/.test(l)));
  assert.ok(ctx.state.getLateTurn(AGENT, nonce)?.followUp);
});

test("batch2 #3: a desktop user's turn (other client nonce) is never linked to a WhatsApp watch", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = (body) => { ctx.gw.entries.pop(); realStyle(ctx, body.clientNonce, 5, ["ok"]); };
  await ctx.bridge.handleEvent(mention("hi"));
  ctx.gw.entries.push({ id: "t6u", kind: "message", role: "user", clientNonce: "desktop-uuid", content: "private", timestampMs: Date.now() });
  ctx.gw.entries.push({ id: "t6s0", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "private desktop answer for the owner" } });
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["ok"]);
});

test("batch2 #1: turn access is persisted with the watch; after a restart a faq-only turn is still filtered, and unknown access fails closed", async () => {
  const groups = [{ jid: GROUP, name: "Test Group", agent: AGENT, mode: "mention", members: [{ name: "Boss", role: "admin", ids: ["+10999999999"] }] }];
  const first = await setup({ groups });
  first.gw.onPrompt = () => { first.gw.reply("ok"); };
  const event = mention("price?");
  await first.bridge.handleEvent(event);
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  assert.equal(first.state.getLateTurn(AGENT, nonce)?.access, "faq-only", "sender not on member list -> faq-only persisted");
  const second = await setup({ statePath: first.statePath, groups });
  second.gw.entries = first.gw.entries; second.gw.seq = first.gw.seq;
  second.gw.reply("Invoice INV-2026-001 total RM 1,500.00 due Friday");
  await second.bridge.pollLateOnce();
  assert.equal(texts(second).some((t) => /INV-2026-001|1,500/.test(t ?? "")), false);
  // Unknown access (no record field) in a member-list group -> faq-only.
  await second.state.setLateTurn(AGENT, nonce, { access: undefined });
  assert.equal(second.bridge.accessFor(AGENT, nonce, GROUP), "faq-only");
  assert.equal(second.bridge.accessFor(AGENT, "whatsapp:x@g.us:none", OTHER_GROUP), undefined, "group without member list: no guard");
});

test("batch2 #2: duplicate-text guard compares the full split message, ignores short texts, and survives a restart", async () => {
  const groups = [{ jid: GROUP, name: "Test Group", agent: AGENT, mode: "mention", splitReplies: true }];
  const long = "Here are three picks for Wednesday.\n\nFirst, Cafe One downtown.\n\nSecond, Cafe Two uptown.\n\nThird, Cafe Three.";
  const first = await setup({ groups });
  first.gw.onPrompt = () => { first.gw.reply(long); first.gw.reply("Noted"); };
  await first.bridge.handleEvent(mention("picks?"));
  assert.ok(first.transport.sent.length >= 2);
  const second = await setup({ statePath: first.statePath, groups });
  second.gw.entries = first.gw.entries; second.gw.seq = first.gw.seq;
  second.gw.reply(long);      // regenerated duplicate of the split message
  second.gw.reply("Noted");   // short: exempt
  second.bridge.followUpIdle.clear();
  await second.bridge.pollLateOnce();
  assert.deepEqual(texts(second), ["Noted"]);
  assert.ok(second.log.lines.some((l) => /Late duplicate text skipped/.test(l)));
});

test("batch2 #4: several messages arrive mid-turn; a late post for the first lands after newer answers and quotes its own question", async () => {
  const ctx = await setup();
  let n = 0;
  ctx.gw.onPrompt = (body) => {
    n += 1;
    ctx.gw.entries.pop();
    realStyle(ctx, body.clientNonce, n, [n === 1 ? "Checking, give me a minute." : `Answer ${n}`]);
  };
  const a = mention("first question about dinner");
  await ctx.bridge.handleEvent(a);
  const b = ctx.bridge.handleEvent(mention("second question"));
  const c = ctx.bridge.handleEvent(mention("third question"));
  await Promise.all([b, c]);
  assert.deepEqual(texts(ctx), ["Checking, give me a minute.", "Answer 2", "Answer 3"]);
  // Turn 1's result lands after the newer answers.
  ctx.gw.entries.push({ id: "t1s1", kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: "Result for the first question: table for 6 is free at 7:30pm" } });
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  const late = ctx.transport.sent.at(-1);
  assert.equal(late.text, "Result for the first question: table for 6 is free at 7:30pm");
  assert.equal(late.quoted, a.id, "quotes its own (first) question");
  assert.equal(ctx.log.lines.some((l) => /reason=superseded/.test(l)), false);
});

test("batch2 #5: after a restart (no cached message) the late post quotes a persisted stub of its question; without participant it falls back to 'Re: …'", async () => {
  const first = await setup();
  first.gw.onPrompt = () => { first.gw.reply("ack"); };
  const event = mention("is the cafe open next Wednesday?");
  await first.bridge.handleEvent(event);
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  const saved = first.state.getTurnQuote(AGENT, nonce);
  assert.equal(saved.text, "is the cafe open next Wednesday?");
  assert.equal(saved.participant, "123456789012345@lid");
  const second = await setup({ statePath: first.statePath });
  second.gw.entries = first.gw.entries; second.gw.seq = first.gw.seq;
  second.gw.reply("Yes, the cafe is open on Wednesday from 6pm");
  second.bridge.followUpIdle.clear();
  await second.bridge.pollLateOnce();
  assert.equal(second.transport.sent[0].quoted, event.id, "stub quote after restart");
  // No participant -> no stub possible -> Re: line instead of a quote.
  await second.state.setTurnQuote(AGENT, nonce, { chatId: GROUP, msgId: event.id, text: "is the cafe open next Wednesday?" });
  second.gw.reply("Update: they close at 10pm that night");
  second.bridge.followUpIdle.clear();
  await second.bridge.pollLateOnce();
  const last = second.transport.sent.at(-1);
  assert.equal(last.quoted, undefined);
  assert.match(last.text, /^Re: "is the cafe open next Wednesday\?"\n\nUpdate: they close at 10pm/);
});

test("batch2 #6: a reply wait that times out after a host pause retries the prompt once (logged), and a late answer to the original is not posted too", async () => {
  const ctx = await setup({ replyTimeoutMs: 200 });
  let prompts = 0;
  ctx.gw.onPrompt = (body) => {
    prompts += 1;
    if (prompts === 1) { ctx.gw.status = { isRunning: true }; ctx.transport.lastPauseAt = Date.now() + 50; return; }
    ctx.gw.status = { isRunning: false };
    ctx.gw.reply("Here is your answer after the retry", { clientNonce: undefined });
  };
  const event = mention("hi, what's my balance?");
  await ctx.bridge.ingest(event);
  assert.equal(prompts, 2, "retried exactly once");
  assert.match(ctx.gw.prompts[1].clientNonce, /:retry$/);
  assert.deepEqual(texts(ctx), ["Here is your answer after the retry"]);
  assert.ok(ctx.log.lines.some((l) => /Pause retry chat=120363000000000021@g\.us msg=M\d+/.test(l)));
  assert.equal(texts(ctx).includes(ERROR_NOTICE), false);
  // The original (pre-pause) turn answers late: not posted as well.
  const t = ctx.gw.entries.findIndex((e) => e.clientNonce === `whatsapp:${GROUP}:${event.id}`);
  assert.ok(t >= 0);
  assert.equal(ctx.state.getLateTurn(AGENT, `whatsapp:${GROUP}:${event.id}`), undefined);
});

test("batch2 #6: no pause -> no retry (plain timeout keeps the old behaviour)", async () => {
  const ctx = await setup({ replyTimeoutMs: 200 });
  let prompts = 0;
  ctx.gw.onPrompt = () => { prompts += 1; ctx.gw.status = { isRunning: true }; };
  await ctx.bridge.ingest(mention("slow job"));
  assert.equal(prompts, 1);
  assert.deepEqual(texts(ctx), [ERROR_NOTICE]);
});

// ---------- unrecorded prompt after a host pause ----------

test("pause: replies to a prompt sent just before a pause whose state write was lost are adopted and posted once (access from the trusted header)", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = (body) => { ctx.gw.entries.pop(); realStyle(ctx, body.clientNonce, 218, ["menu"]); };
  await ctx.bridge.handleEvent(mention("what can you do?"));
  const lost = `whatsapp:${GROUP}:LOSTMSG`;
  const at = Date.now();
  ctx.gw.entries.push({ id: "t219u", kind: "message", role: "user", clientNonce: lost, timestampMs: at,
    content: "[whatsapp-from] name=\"Alex\"\n[whatsapp-role] role=friend authorised=Y access=account\n\nweather?" });
  ctx.gw.entries.push({ id: "t219s475", kind: "send-message", timestampMs: at, message: { type: "text", content: "Checking the weather now." } });
  ctx.gw.entries.push({ id: "t219s476", kind: "send-message", timestampMs: at, message: { type: "text", content: "It will rain in all three today" } });
  ctx.transport.lastPauseAt = at + 20_000; ctx.transport.lastPauseMs = 126_000;
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["menu", "Checking the weather now.", "It will rain in all three today"]);
  assert.ok(ctx.log.lines.some((l) => /Late message adopted .*entry=t219s475 .*reason=prompt-unrecorded-after-pause/.test(l)));
  assert.equal(ctx.state.getLateTurn(AGENT, lost)?.access, "account");
});

test("pause: an unrecorded prompt is still skipped without a pause, or when another turn handled the same message", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = (body) => { ctx.gw.entries.pop(); realStyle(ctx, body.clientNonce, 10, ["hi"]); };
  await ctx.bridge.handleEvent(mention("hello"));
  const at = Date.now();
  ctx.gw.entries.push({ id: "t11u", kind: "message", role: "user", clientNonce: `whatsapp:${GROUP}:NOPAUSE`, timestampMs: at, content: "x" });
  ctx.gw.entries.push({ id: "t11s0", kind: "send-message", timestampMs: at, message: { type: "text", content: "no pause: must not post" } });
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["hi"]);
  // Pause now, but the same message was re-handled under another nonce (e.g. a batch after the rollback).
  await ctx.state.setTurnQuote(AGENT, `whatsapp:${GROUP}:DUPMSG:batch2`, { chatId: GROUP, msgId: "DUPMSG" });
  ctx.gw.entries.push({ id: "t12u", kind: "message", role: "user", clientNonce: `whatsapp:${GROUP}:DUPMSG`, timestampMs: at, content: "x" });
  ctx.gw.entries.push({ id: "t12s0", kind: "send-message", timestampMs: at, message: { type: "text", content: "duplicate of the lost run" } });
  ctx.transport.lastPauseAt = at + 5_000; ctx.transport.lastPauseMs = 60_000;
  ctx.bridge.followUpIdle.clear();
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(texts(ctx), ["hi"]);
  assert.ok(ctx.log.lines.some((l) => /entry=t12s0 reason=prompt-not-pending/.test(l)));
});
