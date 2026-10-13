/**
 * 2026-10-13 efficiency/reliability changes: light reconnects, pending-only late
 * poller with backoff, late-delivery guards, prompt reuse, inbound journal,
 * durable state writes, ensure timeout and the health summary. All offline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WhatsAppBridge } from "../src/bridge.js";
import { LoopGuard } from "../src/core/loop-guard.js";
import { ChatRouter } from "../src/core/routing.js";
import { GrokClient } from "../src/grok-client.js";
import { InboundJournal } from "../src/journal.js";
import { JsonStateStore } from "../src/state.js";
import { BaileysTransport } from "../src/whatsapp/baileys-adapter.js";
import { StatusFile } from "../src/whatsapp/status.js";
import { writeFileDurable } from "../src/durable-fs.js";
import { fakeAuthStateFactory, fakeSocketFactory, recordingLog, waitFor, writePairedCreds } from "./helpers/fake-baileys.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const AGENT = "agent-pj";
const GROUP = "120363000000000021@g.us";
const SELF = "60111111111@s.whatsapp.net";

// ---------- 1) light reconnects ----------

function adapterSetup(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-eff-"));
  const authDir = path.join(dir, "auth");
  writePairedCreds(authDir);
  const statusPath = path.join(dir, "state", "status.json");
  const status = new StatusFile(statusPath);
  const log = recordingLog();
  const groups = { [GROUP]: { id: GROUP, subject: "PJ", participants: [{ id: "1@lid" }] } };
  const makeSocket = fakeSocketFactory({ groups });
  let listCalls = 0;
  const counted = (options) => {
    const sock = makeSocket(options);
    const original = sock.groupFetchAllParticipating.bind(sock);
    sock.groupFetchAllParticipating = async () => { listCalls += 1; return original(); };
    return sock;
  };
  counted.sockets = makeSocket.sockets;
  const transport = new BaileysTransport({
    authDir, groups: [{ jid: GROUP, name: "PJ" }], log, status, onEvent: () => {}, makeSocket: counted,
    authStateFactory: fakeAuthStateFactory(), heartbeatMs: 3_600_000, pauseCheckMs: 0,
    groupsListPath: path.join(dir, "state", "groups.json"), ...extra,
  });
  const readStatus = async () => { await status.queue; return StatusFile.read(statusPath); };
  return { transport, sockets: makeSocket.sockets, log, readStatus, listCalls: () => listCalls };
}

test("eff 1: reconnect backoff is capped at ~60s by default", () => {
  const ctx = adapterSetup();
  assert.equal(ctx.transport.backoff.maxMs, 60_000);
  ctx.transport.attempts = 12;
  ctx.transport.scheduleReconnect(408);
  const line = ctx.log.lines.find((l) => /reconnect attempt 13 in (\d+)ms/.test(l));
  const delay = Number(/in (\d+)ms/.exec(line)[1]);
  assert.ok(delay <= 72_000, `delay ${delay} capped (60s +20% jitter)`);
  clearTimeout(ctx.transport.reconnectTimer);
});

test("eff 1: after a short pause the bridge reconnects at once (no wait for the dead socket) and skips the full group check", async () => {
  let wall = 5_000_000; let mono = 1_000;
  const ctx = adapterSetup({ now: () => wall, monotonic: () => mono, resumeReconnectDelayMs: 5, backoff: { baseMs: 5, maxMs: 20 } });
  void ctx.transport.start();
  await waitFor(() => ctx.sockets.length === 1);
  ctx.sockets[0].open();
  await waitFor(() => ctx.log.lines.some((l) => /Group check configured=1 visible=1 missing=0/.test(l)));
  assert.equal(ctx.listCalls(), 1, "fresh start: full check");

  ctx.transport.lastClock = { wall, mono };
  wall += 60_000; mono += 5_000; // 55s pause
  assert.equal(ctx.transport.checkPause(), true);
  assert.ok(ctx.sockets[0].ended, "old socket ended");
  await waitFor(() => ctx.sockets.length === 2, 1_000);
  // The detached socket's late close event must not schedule another reconnect.
  ctx.sockets[0].close(408);
  ctx.sockets[1].open();
  await waitFor(() => ctx.log.lines.some((l) => /Group check skipped \(light reconnect, down 55s\)/.test(l)));
  assert.equal(ctx.listCalls(), 1, "no group re-listing after a short pause");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ctx.sockets.length, 2, "no extra reconnect from the detached socket");
  assert.equal(ctx.log.lines.filter((l) => /WhatsApp disconnected/.test(l)).length, 0);
  const status = await ctx.readStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.groupsCheck, "ok");
  await ctx.transport.stop();
});

test("eff 1: a long outage (> 3 min) or an empty cache triggers the full group check", async () => {
  let wall = 5_000_000; let mono = 1_000;
  const ctx = adapterSetup({ now: () => wall, monotonic: () => mono, resumeReconnectDelayMs: 5 });
  void ctx.transport.start();
  await waitFor(() => ctx.sockets.length === 1);
  ctx.sockets[0].open();
  await waitFor(() => ctx.listCalls() === 1);
  ctx.transport.lastClock = { wall, mono };
  wall += 300_000; mono += 5_000; // ~5 min pause
  ctx.transport.checkPause();
  await waitFor(() => ctx.sockets.length === 2, 1_000);
  ctx.sockets[1].open();
  await waitFor(() => ctx.listCalls() === 2);
  assert.equal(ctx.transport.needsFullGroupCheck(10_000), false, "short outage with a full cache: light");
  ctx.transport.groupMeta.clear();
  assert.equal(ctx.transport.needsFullGroupCheck(10_000), true, "empty cache: full");
  assert.equal(ctx.transport.needsFullGroupCheck(undefined), true, "unknown downtime (fresh start): full");
  await ctx.transport.stop();
});

test("eff 1: ensure is wrapped in a timeout that never signals the bridge's process group", () => {
  const script = readFileSync(path.join(ROOT, "deploy/whatsapp-bridge-control.sh"), "utf8");
  assert.match(script, /ENSURE_TIMEOUT_SECONDS=\$\{ENSURE_TIMEOUT_SECONDS:-\d+\}/);
  assert.match(script, /WA_ENSURE_INNER=1 timeout --foreground -k 10 "\$ENSURE_TIMEOUT_SECONDS" "\$0" ensure/);
  assert.match(script, /control: ensure timed out/);
  execFileSync("sh", ["-n", path.join(ROOT, "deploy/whatsapp-bridge-control.sh")]);
});

// ---------- bridge fixtures ----------

function fakeGateway() {
  const gw = {
    entries: [], prompts: [], seq: 0, tailCalls: 0, failTail: 0,
    status: { isRunning: false, isRunningTurn: false, isComposingMessage: false },
    onPrompt: undefined,
    id(prefix) { gw.seq += 1; return `${prefix}${gw.seq}`; },
    reply(text) {
      const entry = { id: gw.id("s"), kind: "send-message", timestampMs: Date.now(), message: { type: "text", content: text } };
      gw.entries.push(entry);
      return entry;
    },
  };
  const handlers = {
    listAgents: () => ({ agents: [{ id: AGENT, name: "PJ", ...gw.status }] }),
    sendPrompt: (body) => {
      gw.prompts.push(body);
      gw.entries.push({ id: gw.id("u"), kind: "message", role: "user", clientNonce: body.clientNonce, content: body.prompt, timestampMs: Date.now() });
      gw.onPrompt?.(body);
      return { accepted: true };
    },
    getAgentTranscriptTail: ({ limit }) => ({ entries: gw.entries.slice(-limit) }),
    getAgentTranscript: () => ({ entries: gw.entries }),
  };
  gw.fetchImpl = async (url, init) => {
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const method = url.split("/api/")[1];
    if (method === "getAgentTranscriptTail") {
      gw.tailCalls += 1;
      if (gw.failTail > 0) { gw.failTail -= 1; return { ok: false, status: 500, json: async () => ({}) }; }
    }
    const result = handlers[method]?.(JSON.parse(init.body || "{}"));
    return { ok: Boolean(handlers[method]), status: handlers[method] ? 200 : 404, json: async () => ({ result }) };
  };
  return gw;
}

async function bridgeSetup({ statePath, now, journal, replyTimeoutMs = 5_000, transportExtra = {} } = {}) {
  const dir = statePath ? path.dirname(statePath) : mkdtempSync(path.join(tmpdir(), "wa-eff-b-"));
  const gw = fakeGateway();
  const state = new JsonStateStore(statePath ?? path.join(dir, "bridge-state.json"));
  await state.load();
  const router = new ChatRouter({ defaultAgent: AGENT, dms: [], groups: [{ jid: GROUP, name: "PJ Boys", agent: AGENT, mode: "mention" }] });
  const log = recordingLog();
  const sent = [];
  const transport = {
    sent,
    selfIds: () => [SELF],
    sendText: async (chatId, text, options = {}) => { sent.push({ chatId, text, quoted: options.quoted?.key?.id }); return { id: `B${sent.length}` }; },
    setTyping: async () => {},
    chatName: () => "PJ Boys",
    ...transportExtra,
  };
  const grok = new GrokClient("http://127.0.0.1:1340", "t", { fetchImpl: gw.fetchImpl, pollIntervalMs: 10, replyTimeoutMs });
  const bridge = new WhatsAppBridge({
    grok, state, router, guard: new LoopGuard(), transport, log, journal,
    options: { sendDelayMs: 0, stableReplyMs: 40, lateDeliveryPollMs: 10, typingIndicator: false, ...(now ? { now } : {}) },
  });
  return { dir, gw, state, bridge, transport, log, sent, texts: () => sent.map((s) => s.text) };
}

let seq = 0;
function mention(text) {
  seq += 1;
  const id = `E${seq}`;
  return {
    id, chatId: GROUP, sender: { jid: "123456789012345@lid" }, kind: "text", text: `@60111111111 ${text}`,
    mentionedJids: [SELF], timestamp: Math.floor(Date.now() / 1000), raw: { key: { id, remoteJid: GROUP }, message: { mediaKey: Buffer.from([1, 2, 3]) } },
  };
}
const nonceOf = (event) => `whatsapp:${GROUP}:${event.id}`;

// ---------- 2) pending-only poller with backoff ----------

test("eff 2: the poller only polls agents with a pending turn, backs off with jitter on HTTP 500, and recovers", async () => {
  const ctx = await bridgeSetup();
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.gw.tailCalls, 0, "nothing pending: zero gateway calls");
  const nonce = `whatsapp:${GROUP}:P1`;
  ctx.gw.entries.push({ id: "t1s0", kind: "message", role: "user", clientNonce: nonce, timestampMs: Date.now() });
  await ctx.state.setLateTurn(AGENT, nonce, { chatId: GROUP, sentAt: Date.now(), armedAt: Date.now(), reason: "timeout" });
  ctx.gw.failTail = 1;
  await ctx.bridge.pollLateOnce();
  const backoff = ctx.bridge.latePollBackoff.get(AGENT);
  assert.equal(backoff?.failures, 1);
  assert.ok(ctx.log.lines.some((l) => /Late delivery failed agent=agent-pj reason=.*HTTP 500; retry in \d+ms \(failures=1\)/.test(l)));
  const calls = ctx.gw.tailCalls;
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.gw.tailCalls, calls, "inside the backoff window: not polled again");
  backoff.nextAt = 0;
  ctx.gw.reply("late answer");
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(ctx.texts(), ["late answer"]);
  assert.equal(ctx.bridge.latePollBackoff.has(AGENT), false, "success clears the backoff");
  assert.equal(ctx.state.getLateTurn(AGENT, nonce), undefined, "answered: no longer polled");
  const after = ctx.gw.tailCalls;
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.gw.tailCalls, after);
});

test("eff 2: backoff delay grows exponentially, is jittered and capped", () => {
  const bridge = new WhatsAppBridge({ grok: {}, state: {}, router: {}, guard: {}, transport: {}, log: recordingLog(), options: { lateDeliveryPollMs: 3_000, latePollMaxBackoffMs: 60_000 } });
  for (let i = 0; i < 50; i += 1) {
    const d1 = bridge.latePollDelayMs(1);
    assert.ok(d1 >= 3_000 && d1 <= 6_000, `d1=${d1}`);
    const d10 = bridge.latePollDelayMs(10);
    assert.ok(d10 >= 30_000 && d10 <= 60_000, `d10=${d10}`);
  }
  assert.equal(WhatsAppBridge.isTransientGatewayError(new Error("Grok gateway getAgentTranscriptTail failed with HTTP 500")), true);
  assert.equal(WhatsAppBridge.isTransientGatewayError(new Error("The operation was aborted due to timeout")), true);
});

test("eff 2: a pending turn older than lateMaxAgeMs is given up (logged) and never polled", async () => {
  let clock = Date.now();
  const ctx = await bridgeSetup({ now: () => clock });
  const nonce = `whatsapp:${GROUP}:OLD`;
  await ctx.state.setLateTurn(AGENT, nonce, { chatId: GROUP, sentAt: clock, armedAt: clock, reason: "timeout" });
  clock += 11 * 60_000;
  await ctx.bridge.pollLateOnce();
  assert.equal(ctx.gw.tailCalls, 0);
  assert.equal(ctx.state.getLateTurn(AGENT, nonce), undefined);
  assert.ok(ctx.log.lines.some((l) => /Late reply gave up agent=agent-pj chat=.* msg=OLD reason=expired armed=timeout/.test(l)));
});

// ---------- 3) late-delivery guards ----------

test("eff 3: rollback case: a late entry whose prompt this bridge never recorded is skipped (not posted)", async () => {
  const ctx = await bridgeSetup();
  const known = `whatsapp:${GROUP}:K1`;
  const lost = `whatsapp:${GROUP}:L1`; // prompt sent by a rolled-back run
  const now = Date.now();
  ctx.gw.entries.push(
    { id: "t5s0", kind: "message", role: "user", clientNonce: known, timestampMs: now },
    { id: "t6s0", kind: "message", role: "user", clientNonce: lost, timestampMs: now },
    { id: "t6s1", kind: "send-message", timestampMs: now, message: { type: "text", content: "Ouch" } },
  );
  await ctx.state.setLateTurn(AGENT, known, { chatId: GROUP, sentAt: now, armedAt: now, reason: "timeout" });
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(ctx.texts(), [], "duplicate from the lost run is not posted");
  assert.ok(ctx.log.lines.some((l) => /Late message skipped .*entry=t6s1 reason=prompt-not-pending/.test(l)));
});

test("eff 3: an older pending turn is not answered after a newer turn in the same chat was answered; background turns are exempt", async () => {
  const ctx = await bridgeSetup();
  const now = Date.now();
  const older = `whatsapp:${GROUP}:O1`;
  const bg = `whatsapp:${GROUP}:BG1`;
  ctx.gw.entries.push(
    { id: "t7s0", kind: "message", role: "user", clientNonce: older, timestampMs: now },
    { id: "t8s0", kind: "message", role: "user", clientNonce: bg, timestampMs: now },
    { id: "t7s1", kind: "send-message", timestampMs: now, message: { type: "text", content: "stale answer" } },
    { id: "t8s1", kind: "send-message", timestampMs: now, message: { type: "text", content: "background result" } },
  );
  await ctx.state.setLateTurn(AGENT, older, { chatId: GROUP, sentAt: now - 5_000, armedAt: now, reason: "timeout" });
  await ctx.state.setLateTurn(AGENT, bg, { chatId: GROUP, sentAt: now - 6_000, armedAt: now, reason: "background", background: true });
  await ctx.state.markChatAnswered(GROUP, now - 1_000); // a newer turn got its answer
  await ctx.bridge.pollLateOnce();
  assert.deepEqual(ctx.texts(), ["background result"]);
  assert.ok(ctx.log.lines.some((l) => /entry=t7s1 reason=superseded/.test(l)));
});

test("eff 3: a live turn that ends with a background task still running stays pending; a normal turn does not", async () => {
  const ctx = await bridgeSetup();
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true };
    setTimeout(() => { ctx.gw.reply("on it"); ctx.gw.status = { isRunning: true, isRunningTurn: false }; }, 10);
  };
  const event = mention("make the report");
  await ctx.bridge.handleEvent(event);
  const record = ctx.state.getLateTurn(AGENT, nonceOf(event));
  assert.equal(record?.background, true);
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: false, isRunningTurn: false }; ctx.gw.reply("done"); };
  const second = mention("thanks");
  await ctx.bridge.handleEvent(second);
  assert.equal(ctx.state.getLateTurn(AGENT, nonceOf(second)), undefined);
  assert.ok(ctx.state.getChatAnswered(GROUP) >= record.sentAt);
});

test("eff 3: a replayed message whose prompt is already in the transcript is reused, not sent again", async () => {
  const ctx = await bridgeSetup();
  const event = { ...mention("hello again"), replayed: true, catchUp: true };
  ctx.gw.entries.push({ id: "t9s0", kind: "message", role: "user", clientNonce: nonceOf(event), timestampMs: Date.now() });
  setTimeout(() => ctx.gw.reply("answer to the original prompt"), 20);
  await ctx.bridge.ingest(event);
  assert.equal(ctx.gw.prompts.length, 0, "sendPrompt not called");
  assert.deepEqual(ctx.texts(), ["answer to the original prompt"]);
  assert.equal(ctx.bridge.metrics.promptsReused, 1);
  assert.ok(ctx.log.lines.some((l) => /Prompt reused chat=.* msg=E\d+/.test(l)));
});

test("eff 3: a message received before the last box pause is checked against the transcript; a fresh one is not", async () => {
  const transportExtra = { lastPauseAt: Date.now() + 1_000, lastPauseMs: 60_000 };
  const ctx = await bridgeSetup({ transportExtra });
  ctx.gw.onPrompt = () => ctx.gw.reply("ok");
  await ctx.bridge.ingest(mention("before the pause"));
  assert.equal(ctx.gw.prompts.length, 1, "not in transcript -> sent normally");
  assert.equal(ctx.bridge.mayHaveSentBefore({ id: "x", receivedAt: Date.now() + 5_000 }), false, "after the pause: no extra check");
});

// ---------- 4) durability ----------

test("eff 4: accepted inbound is journaled before dispatch and removed once the agent has the prompt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-eff-j-"));
  const journal = new InboundJournal(path.join(dir, "inbound-journal.json")).load();
  const ctx = await bridgeSetup({ journal });
  let journaledAtPrompt;
  ctx.gw.onPrompt = () => { journaledAtPrompt = journal.size; ctx.gw.reply("hi"); };
  const event = mention("hello");
  const task = ctx.bridge.ingest(event);
  assert.equal(journal.size, 1, "on disk before the queue runs");
  const onDisk = JSON.parse(readFileSync(journal.filename, "utf8"));
  assert.equal(onDisk.entries[0].key, `${GROUP}|${event.id}`);
  await task;
  assert.equal(journaledAtPrompt, 1);
  assert.equal(journal.size, 0, "removed after the prompt was accepted");
  assert.equal(JSON.parse(readFileSync(journal.filename, "utf8")).entries.length, 0);
});

test("eff 4: SIGTERM/abort keeps queued messages in the journal; replay at start handles them once (Buffers intact)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-eff-j2-"));
  const file = path.join(dir, "inbound-journal.json");
  const journal = new InboundJournal(file).load();
  const ctx = await bridgeSetup({ journal });
  ctx.gw.onPrompt = () => ctx.gw.reply("first");
  const abort = new AbortController();
  // Agent queue busy with a long turn so the second message waits in memory.
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: true, isRunningTurn: true }; };
  const busy = ctx.bridge.ingest(mention("long one"), { signal: abort.signal }).catch(() => {});
  await waitFor(() => ctx.gw.prompts.length === 1);
  const queued = mention("queued one");
  const waiting = ctx.bridge.ingest(queued, { signal: abort.signal }).catch(() => {});
  abort.abort();
  await Promise.allSettled([busy, waiting]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(journal.list().map((e) => e.key), [`${GROUP}|${queued.id}`], "only the never-prompted message stays");

  // Next start: reload the journal from disk and replay.
  const reloaded = new InboundJournal(file).load();
  assert.ok(Buffer.isBuffer(reloaded.list()[0].event.raw.message.mediaKey), "raw Buffers survive the round trip");
  const next = await bridgeSetup({ journal: reloaded });
  next.gw.onPrompt = () => next.gw.reply("answer to queued");
  const replayed = await next.bridge.replayJournal();
  assert.equal(replayed, 1);
  assert.equal(next.gw.prompts.length, 1);
  assert.match(next.gw.prompts[0].clientNonce, new RegExp(`${queued.id}$`));
  assert.deepEqual(next.texts(), ["answer to queued"]);
  assert.equal(reloaded.size, 0);
});

test("eff 4: replay drops too-old journal entries and duplicate in-flight deliveries are ignored", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-eff-j3-"));
  const journal = new InboundJournal(path.join(dir, "j.json")).load();
  const old = { ...mention("ancient"), timestamp: Math.floor(Date.now() / 1000) - 3_600 };
  journal.add(old, Date.now() - 3_600_000);
  const ctx = await bridgeSetup({ journal });
  assert.equal(await ctx.bridge.replayJournal(), 0);
  assert.equal(journal.size, 0);
  assert.ok(ctx.log.lines.some((l) => /Journal entry dropped \(too old\)/.test(l)));
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: true, isRunningTurn: true }; setTimeout(() => { ctx.gw.reply("x"); ctx.gw.status = { isRunning: false, isRunningTurn: false }; }, 50); };
  const event = mention("twice");
  const first = ctx.bridge.ingest(event);
  const second = await ctx.bridge.ingest({ ...event });
  assert.equal(second.dropped, "duplicate-inflight");
  await first;
  assert.equal(ctx.gw.prompts.length, 1);
});

test("eff 4: state writes are durable (unique temp + fsync + rename), leave no temp files and flush() waits for them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-eff-s-"));
  const file = path.join(dir, "bridge-state.json");
  // A leftover temp file from a crashed run with the same pid must not block saves.
  writeFileSync(`${file}.${process.pid}.tmp`, "junk", { mode: 0o600 });
  const state = new JsonStateStore(file);
  await state.load();
  await Promise.all([state.setLateTurn("a", "n1", { chatId: GROUP, sentAt: 1, armedAt: 1 }), state.markChatAnswered(GROUP, 5), state.setMirrorCursor("a", "t1s1")]);
  await state.flush();
  const reloaded = new JsonStateStore(file);
  await reloaded.load();
  assert.equal(reloaded.getLateTurn("a", "n1").chatId, GROUP);
  assert.equal(reloaded.getChatAnswered(GROUP), 5);
  assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp") && !name.startsWith(`bridge-state.json.${process.pid}.tmp`)).length, 0);
  await writeFileDurable(path.join(dir, "x.json"), "{}\n");
  assert.equal(readFileSync(path.join(dir, "x.json"), "utf8"), "{}\n");
});

// ---------- 5) health summary ----------

test("eff 5: health summary reads only new log lines (offset file) and has a daily pause mode", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-eff-h-"));
  const log = path.join(dir, "bridge.log");
  const status = path.join(dir, "status.json");
  const offset = path.join(dir, "offset");
  writeFileSync(status, JSON.stringify({ state: "connected", groupsConfigured: 9, groupsVisible: new Array(9).fill("g"), groupsMissing: [], updatedAt: new Date().toISOString(), latePolls: 3 }));
  const t = (min) => new Date(Date.now() - min * 60_000).toISOString();
  writeFileSync(log, [
    `${t(30)} WARN wa-bridge: Box was paused for about 240s (wall clock jumped, monotonic did not); refreshing heartbeat`,
    `${t(29)} INFO wa-bridge: WhatsApp connected account=••1234 downMs=240000`,
    `${t(29)} INFO wa-bridge: Group check configured=9 visible=9 missing=0`,
    `${t(28)} WARN wa-bridge: Late delivery failed agent=a reason=Grok gateway getAgentTranscriptTail failed with HTTP 500; retry in 4000ms (failures=1)`,
    `${t(27)} INFO wa-bridge: Drop inbound reason=group-not-allowlisted chat=x msg=y`,
    "",
  ].join("\n"));
  const env = { ...process.env, BRIDGE_HOME: dir, WA_BRIDGE_LOG: log, WA_BRIDGE_STATUS: status, WA_HEALTH_OFFSET: offset };
  const run = (...a) => execFileSync(process.execPath, [path.join(ROOT, "scripts/health-summary.mjs"), ...a], { env, encoding: "utf8" });
  const first = run();
  assert.match(first, /state=connected groups=9\/9/);
  assert.match(first, /pauses=1 reconnects=1 fullGroupChecks=1 light=0/);
  assert.match(first, /pollFails=1 \(http5xx=1\)/);
  assert.match(first, /group-not-allowlisted=1 \(notable=1\)/);
  assert.ok(first.trim().split("\n").length <= 6, "a few lines only");
  appendFileSync(log, `${t(1)} INFO wa-bridge: Group check skipped (light reconnect, down 40s) cached configured=9 visible=9 missing=0\n`);
  const second = run();
  assert.match(second, /lines=1: pauses=0 reconnects=0 fullGroupChecks=0 light=1/, "only the new line is read");
  const daily = run("--daily");
  assert.match(daily, /pauses=1 \(>3min=1, <=3min=0\)/);
  assert.match(daily, /pauses by KL hour: \d\d:1/);
});
