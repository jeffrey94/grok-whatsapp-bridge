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

const AGENT = "agent-pj";
const OTHER_AGENT = "agent-other";
const GROUP = "120363000000000021@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const OWNER = "60123456789@s.whatsapp.net";
const SELF = "60111111111@s.whatsapp.net";

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
    listAgents: () => ({ agents: [{ id: AGENT, name: "PJ", ...gw.status }, { id: OTHER_AGENT, name: "Other", isRunning: false }] }),
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
    chatName: () => "PJ Boys",
  };
}

async function setup({ replyTimeoutMs = 5_000, groups, statePath, now } = {}) {
  const dir = statePath ? path.dirname(statePath) : mkdtempSync(path.join(tmpdir(), "wa-late-"));
  const gw = fakeGateway();
  const state = new JsonStateStore(statePath ?? path.join(dir, "bridge-state.json"));
  await state.load();
  const router = new ChatRouter({
    defaultAgent: OTHER_AGENT,
    dms: [{ id: OWNER, agent: AGENT }],
    groups: groups ?? [
      { jid: GROUP, name: "PJ Boys", agent: AGENT, mode: "mention" },
      { jid: OTHER_GROUP, name: "Other", agent: OTHER_AGENT, mode: "mention" },
    ],
  });
  const log = recordingLog();
  const transport = fakeTransport();
  const grok = new GrokClient("http://127.0.0.1:1340", "t", { fetchImpl: gw.fetchImpl, pollIntervalMs: 10, replyTimeoutMs });
  const bridge = new WhatsAppBridge({
    grok, state, router, guard: new LoopGuard(), transport, log,
    options: { sendDelayMs: 0, stableReplyMs: 40, lateDeliveryPollMs: 10, typingIndicator: false, ...(now ? { now } : {}) },
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
    text: `@60111111111 ${text}`,
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
  const ctx = await setup();
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true };
    setTimeout(() => ctx.gw.reply("one"), 10);
    setTimeout(() => ctx.gw.reply("two"), 120);
    setTimeout(() => { ctx.gw.reply("three"); ctx.gw.status = { isRunning: false, isRunningTurn: false }; }, 240);
  };
  const done = ctx.bridge.handleEvent(mention("go"));
  await waitFor(() => ctx.transport.sent.length === 1);
  assert.deepEqual(texts(ctx), ["one"], "first message went out before the others existed");
  await done;
  assert.deepEqual(texts(ctx), ["one", "two", "three"]);
  assert.equal(ctx.transport.sent[1].quoted, undefined, "only the first part is quoted");
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

test("item 2 (eff): a finished turn is not followed: no transcript polls, and later unsolicited messages are not posted", async () => {
  const ctx = await setup();
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

test("item 2: late reply of a pending (timed-out) turn follows its chat, survives a restart, never duplicates, and stops after it is answered", async () => {
  const first = await setup({ replyTimeoutMs: 200 });
  first.gw.onPrompt = () => { first.gw.status = { isRunning: true }; };
  const event = mention("start job");
  await first.bridge.ingest(event);
  assert.deepEqual(texts(first), [ERROR_NOTICE]);
  const nonce = `whatsapp:${GROUP}:${event.id}`;
  assert.equal(first.state.getLateTurn(AGENT, nonce)?.reason, "timeout", "timed-out turn stays pending");

  // Restart: new bridge, same state file, same transcript.
  const second = await setup({ statePath: first.statePath });
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
    groups: [{ jid: GROUP, name: "PJ Boys", agent: OTHER_AGENT, mode: "mention" }],
  });
  second.gw.entries = first.gw.entries;
  second.gw.seq = first.gw.seq;
  second.gw.reply("result for a chat that moved");
  await second.bridge.pollLateOnce();
  assert.equal(second.transport.sent.length, 0);
  assert.ok(second.log.lines.some((line) => /Late message not delivered .*reason=chat-not-configured-for-agent/.test(line)));
});

test("item 2: the follower leaves an agent alone while its live turn is running (no double delivery, order kept)", async () => {
  const ctx = await setup();
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
  const agents = [{ id: AGENT, name: "PJ" }, { id: OTHER_AGENT, name: "Other" }];
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
