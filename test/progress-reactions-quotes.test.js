/**
 * Progress (typing refresh + slowAck), reactions as input, quoting replies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WhatsAppBridge, chatFromNonce, slowAckText, msgIdFromNonce, parseReactToken, lastSenderJid } from "../src/bridge.js";
import { Dispatcher } from "../src/core/dispatcher.js";
import { LoopGuard } from "../src/core/loop-guard.js";
import { ChatRouter } from "../src/core/routing.js";
import { parseConfig } from "../src/config.js";
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
    reacts: [],
    sendReaction: async function (chatId, key, emoji) { this.reacts.push({ chatId, id: key.id, participant: key.participant, emoji }); },
    sendFile: async (chatId, file) => { sent.push({ chatId, file: file.filename }); return { id: `B${sent.length}` }; },
    typing: [],
    botTexts: new Map([["BOTX", "Draft quote: 10 boxes RM50. Reply OK to confirm."]]),
    setTyping: async function (chatId, on) { this.typing.push(on); },
    wasSentByUs(id) { return this.botTexts.has(id); },
    sentTextOf(id) { return this.botTexts.get(id); },
    chatName: () => "PJ Boys",
  };
}

async function setup({ replyTimeoutMs = 5_000, groups, statePath, now, extra = {} } = {}) {
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
    options: { sendDelayMs: 0, stableReplyMs: 40, lateDeliveryPollMs: 10, typingIndicator: false, forwardReactions: true, mirrorAgentReactions: true, ...(now ? { now } : {}), ...extra },
  });
  return { dir, gw, state, bridge, transport, log, statePath: state.filename };
}

let msgSeq = 0;
function mention(text, chatId = GROUP, sender = "123456789012345@lid") {
  msgSeq += 1;
  return {
    id: `M${msgSeq}`,
    chatId,
    sender: { jid: sender },
    kind: "text",
    text: `@60111111111 ${text}`,
    mentionedJids: [SELF],
    timestamp: Math.floor(Date.now() / 1000),
    raw: { key: { id: `M${msgSeq}`, remoteJid: chatId } },
  };
}



const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function reaction(emoji, targetId = "BOTX", { chatId = GROUP, sender = "123456789012345@lid", targetParticipant, fromMe = false } = {}) {
  msgSeq += 1;
  return {
    id: `R${msgSeq}`, chatId, fromMe, sender: { jid: sender }, kind: "reaction", text: "", mentionedJids: [],
    reaction: { emoji, targetId, ...(targetParticipant ? { targetParticipant } : {}) },
    timestamp: Math.floor(Date.now() / 1000),
    raw: { key: { id: `R${msgSeq}`, remoteJid: chatId } },
  };
}

function replyAfter(ctx, ms, text) {
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false };
    setTimeout(() => { ctx.gw.status = { isRunning: false, isRunningTurn: false, isComposingMessage: false }; ctx.gw.reply(text); }, ms);
  };
}

// ---- 1) progress ----

test("progress: composing is refreshed while the turn runs and stops (paused) on reply", async () => {
  const ctx = await setup({ extra: { typingIndicator: true, typingRefreshMs: 20 } });
  replyAfter(ctx, 150, "done");
  await ctx.bridge.ingest(mention("slow job"));
  await sleepMs(80);
  const trues = ctx.transport.typing.filter((on) => on === true).length;
  assert.ok(trues >= 4, `refreshed several times (got ${trues})`);
  assert.equal(ctx.transport.typing.at(-1), false, "paused at the end");
  const count = ctx.transport.typing.length;
  await sleepMs(80);
  assert.equal(ctx.transport.typing.length, count, "no refresh after the turn");
});

test("progress: typingRefresh: false on a group sends composing only once", async () => {
  const ctx = await setup({ extra: { typingIndicator: true, typingRefreshMs: 20 }, groups: [{ jid: GROUP, name: "PJ Boys", agent: AGENT, typingRefresh: false }] });
  replyAfter(ctx, 120, "done");
  await ctx.bridge.ingest(mention("slow job"));
  assert.equal(ctx.transport.typing.filter((on) => on === true).length, 1);
});

test("progress: refresh stops on a silent reply", async () => {
  const ctx = await setup({ extra: { typingIndicator: true, typingRefreshMs: 20 } });
  replyAfter(ctx, 60, "NO_WHATSAPP_REPLY");
  await ctx.bridge.ingest(mention("hmm"));
  const count = ctx.transport.typing.length;
  await sleepMs(80);
  assert.equal(ctx.transport.typing.length, count);
  assert.equal(ctx.transport.sent.length, 0);
});

test("slowAck: off by default; on per group sends ONE holding line in the sender's language, then the quoted reply", async () => {
  const off = await setup({ extra: { slowAckMs: 30 } });
  replyAfter(off, 120, "answer");
  await off.bridge.ingest(mention("price?"));
  assert.deepEqual(off.transport.sent.map((s) => s.text), ["answer"]);

  const on = await setup({ extra: { slowAckMs: 30 }, groups: [{ jid: GROUP, name: "PJ Boys", agent: AGENT, slowAck: true }] });
  replyAfter(on, 150, "答案");
  const msg = mention("这个多少钱？");
  await on.bridge.ingest(msg);
  assert.deepEqual(on.transport.sent.map((s) => s.text), ["稍等，我在处理中 🙏", "答案"]);
  assert.equal(on.transport.sent[0].quoted, undefined);
  assert.equal(on.transport.sent[1].quoted, msg.id, "the real reply still quotes the trigger");
  assert.equal(slowAckText("price?"), "One moment, working on it 🙏");

  const fast = await setup({ extra: { slowAckMs: 200 }, groups: [{ jid: GROUP, name: "PJ Boys", agent: AGENT, slowAck: true }] });
  replyAfter(fast, 20, "quick");
  await fast.bridge.ingest(mention("hi"));
  await sleepMs(250);
  assert.deepEqual(fast.transport.sent.map((s) => s.text), ["quick"], "no ack for a fast reply");
});

test("slowAck: never in a group with progressBubbles: false, never for all-mode soft forwards", async () => {
  const quiet = await setup({ extra: { slowAckMs: 30 }, groups: [{ jid: GROUP, name: "Quotes", agent: AGENT, progressBubbles: false, slowAck: true }] });
  replyAfter(quiet, 120, "draft");
  await quiet.bridge.ingest(mention("报价"));
  assert.deepEqual(quiet.transport.sent.map((s) => s.text), ["draft"]);

  const all = await setup({ extra: { slowAckMs: 30 }, groups: [{ jid: GROUP, name: "PJ Boys", agent: AGENT, mode: "all", slowAck: true }] });
  replyAfter(all, 120, "NO_WHATSAPP_REPLY");
  await all.bridge.ingest({ ...mention("anyone around today"), text: "anyone around today", mentionedJids: [] });
  assert.equal(all.transport.sent.length, 0);
});

test("config: progress/reaction/quote keys and defaults", () => {
  const base = { defaultAgent: "a", groups: [{ jid: GROUP, agent: "a" }] };
  const c = parseConfig(base, { readToken: false });
  assert.equal(c.typingRefreshMs, 10_000);
  assert.equal(c.slowAckMs, 25_000);
  assert.equal(c.forwardReactions, false);
  assert.equal(c.mirrorAgentReactions, false);
  assert.equal(c.quoteReplies, true);
  assert.equal(c.quoteInDms, undefined);
  assert.equal(c.groups[0].slowAck, false);
  assert.equal(c.groups[0].typingRefresh, true);
  const d = parseConfig({ ...base, forwardReactions: false, quoteReplies: false, slowAckMs: 40_000, groups: [{ jid: GROUP, agent: "a", slowAck: true, forwardReactions: true }] }, { readToken: false });
  assert.equal(d.forwardReactions, false);
  assert.equal(d.quoteReplies, false);
  assert.equal(d.slowAckMs, 40_000);
  assert.equal(d.groups[0].slowAck, true);
  assert.equal(d.groups[0].forwardReactions, true);
});

// ---- 2) reactions ----

test("reactions: a reaction on a bot message becomes a small trusted prompt; reply is not quoted", async () => {
  const ctx = await setup();
  replyAfter(ctx, 20, "Confirmed, generating the PDF.");
  const r = reaction("👍");
  await ctx.bridge.ingest(r);
  assert.equal(ctx.gw.prompts.length, 1);
  const prompt = ctx.gw.prompts[0].prompt;
  assert.match(prompt, /\[whatsapp-from\]/);
  assert.match(prompt, /\[whatsapp-chat\] jid=120363000000000021@g\.us type=group/);
  assert.match(prompt, /\[whatsapp-reaction\] emoji=👍 on_bot_msg=BOTX on_text="Draft quote: 10 boxes RM50\. Reply OK to confirm\."/);
  assert.match(prompt, /Someone reacted to your message\. Usually no reply is needed \(reply NO_WHATSAPP_REPLY\)/);
  assert.equal(ctx.gw.prompts[0].clientNonce, `whatsapp:${GROUP}:${r.id}:react`);
  assert.equal(ctx.transport.sent.length, 1);
  assert.equal(ctx.transport.sent[0].quoted, undefined, "reaction prompt is never quoted");
});

test("reactions: by participant (bot LID/PN) even when not in the sent cache; text omitted when unknown", async () => {
  const ctx = await setup();
  replyAfter(ctx, 20, "NO_WHATSAPP_REPLY");
  await ctx.bridge.ingest(reaction("✅", "OLDBOT", { targetParticipant: SELF }));
  assert.match(ctx.gw.prompts[0].prompt, /\[whatsapp-reaction\] emoji=✅ on_bot_msg=OLDBOT\n/);
  assert.equal(ctx.transport.sent.length, 0);
});

test("reactions: others' messages, removed reactions, own reactions and forwardReactions=false are ignored", async () => {
  const ctx = await setup();
  assert.equal((await ctx.bridge.ingest(reaction("👍", "SOMEONE", { targetParticipant: "5555@lid" }))).dropped, "reaction-not-on-bot-message");
  assert.equal((await ctx.bridge.ingest(reaction(""))).dropped, "reaction-removed");
  assert.equal((await ctx.bridge.ingest(reaction("👍", "BOTX", { fromMe: true }))).dropped, "own-message");
  assert.equal((await ctx.bridge.ingest(reaction("👍", "BOTX", { sender: SELF }))).dropped, "own-message");
  const off = await setup({ extra: { forwardReactions: false } });
  assert.equal((await off.bridge.ingest(reaction("👍"))).dropped, "reactions-off");
  const groupOff = await setup({ groups: [{ jid: GROUP, name: "PJ Boys", agent: AGENT, forwardReactions: false }] });
  assert.equal((await groupOff.bridge.ingest(reaction("👍"))).dropped, "reactions-off");
  assert.equal(ctx.gw.prompts.length + off.gw.prompts.length + groupOff.gw.prompts.length, 0);
});

test("reactions: DM reactions on bot messages are forwarded too", async () => {
  const ctx = await setup();
  replyAfter(ctx, 20, "NO_WHATSAPP_REPLY");
  await ctx.bridge.ingest(reaction("👌", "BOTX", { chatId: OWNER, sender: OWNER }));
  assert.match(ctx.gw.prompts[0].prompt, /type=dm/);
  assert.match(ctx.gw.prompts[0].prompt, /emoji=👌/);
});

test("reactions: rate limits apply (inbound sender rate)", async () => {
  const ctx = await setup();
  ctx.bridge.guard = new LoopGuard({ inboundPerSenderPerMinute: 1 });
  replyAfter(ctx, 5, "NO_WHATSAPP_REPLY");
  await ctx.bridge.ingest(reaction("👍"));
  const second = await ctx.bridge.ingest(reaction("❤️"));
  assert.equal(second.dropped, "inbound-sender-rate");
});

test("reactions + batch: merged into the backlog prompt; reply quotes the last non-reaction message", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = () => { ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false }; };
  const first = ctx.bridge.ingest(mention("long job"));
  await waitFor(() => ctx.gw.prompts.length === 1, 2_000);
  const a = mention("and 20 boxes?");
  const r = reaction("👍");
  const tasks = [a, r].map((event) => ctx.bridge.ingest(event));
  ctx.gw.onPrompt = () => { setTimeout(() => { ctx.gw.status = { isRunning: false, isRunningTurn: false, isComposingMessage: false }; ctx.gw.reply("20 boxes RM90"); }, 20); };
  ctx.gw.status = { isRunning: false, isRunningTurn: false, isComposingMessage: false };
  ctx.gw.reply("done");
  await first;
  await Promise.all(tasks);
  const prompt = ctx.gw.prompts[1].prompt;
  assert.match(prompt, /^\[whatsapp-batch\] count=2/);
  assert.ok(prompt.indexOf("[whatsapp-reaction] emoji=👍") > prompt.indexOf("and 20 boxes?"));
  const reply = ctx.transport.sent.find((s) => s.text === "20 boxes RM90");
  assert.equal(reply.quoted, a.id);
});

// ---- 3) quoting ----

test("quotes: DMs quote by default; quoteReplies=false and quoteInDms=false switch it off", async () => {
  const dm = (text) => ({ ...mention(text, OWNER, OWNER), text, mentionedJids: [] });
  const ctx = await setup();
  replyAfter(ctx, 10, "hi back");
  const m = dm("hello");
  await ctx.bridge.ingest(m);
  assert.equal(ctx.transport.sent[0].quoted, m.id);

  const off = await setup({ extra: { quoteReplies: false } });
  replyAfter(off, 10, "hi back");
  await off.bridge.ingest(mention("group hello"));
  assert.equal(off.transport.sent[0].quoted, undefined);

  const legacy = await setup({ extra: { quoteInDms: false } });
  replyAfter(legacy, 10, "hi back");
  await legacy.bridge.ingest(dm("hello"));
  assert.equal(legacy.transport.sent[0].quoted, undefined);
});

test("quotes: group reply quotes the trigger; a late agent message quotes the original if cached", async () => {
  const ctx = await setup();
  // The turn ends while a background task keeps the agent running: the turn stays pending for late delivery.
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false };
    setTimeout(() => { ctx.gw.status = { isRunning: true, isRunningTurn: false, isComposingMessage: false }; ctx.gw.reply("on it"); }, 10);
  };
  const m = mention("make the report");
  await ctx.bridge.ingest(m);
  assert.equal(ctx.transport.sent[0].quoted, m.id);
  ctx.gw.reply("report ready");
  await ctx.bridge.pollLateOnce();
  const late = ctx.transport.sent.find((s) => s.text === "report ready");
  assert.ok(late, "late message delivered");
  assert.equal(late.quoted, m.id);
  assert.equal(msgIdFromNonce(`whatsapp:${GROUP}:ABC:batch3`), "ABC");
  assert.equal(msgIdFromNonce(`whatsapp:${GROUP}:nudge-1`), undefined);
});


// ---- mirror agent reactions ----

function agentReacts(ctx, emoji, { after = 30, text } = {}) {
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false };
    setTimeout(() => {
      const prompt = ctx.gw.entries.findLast((e) => e.kind === "message");
      prompt.reactions = [{ emoji, by: AGENT }];
      if (text !== undefined) ctx.gw.reply(text);
      ctx.gw.status = { isRunning: false, isRunningTurn: false, isComposingMessage: false };
    }, after);
  };
}

test("mirror: a reaction-only turn reacts on the trigger message and posts no text", async () => {
  const ctx = await setup({ replyTimeoutMs: 3_000 });
  agentReacts(ctx, "👍");
  const msg = mention("okiee");
  const started = Date.now();
  const result = await ctx.bridge.ingest(msg);
  assert.ok(Date.now() - started < 2_000, "turn ends without waiting for the reply timeout");
  assert.equal(ctx.transport.sent.length, 0);
  assert.deepEqual(ctx.transport.reacts, [{ chatId: GROUP, id: msg.id, participant: undefined, emoji: "👍" }]);
  assert.ok(result);
});

test("mirror: reaction plus text reply sends both; the reaction is sent once", async () => {
  const ctx = await setup();
  agentReacts(ctx, "😂", { text: "haha" });
  const msg = mention("lol");
  await ctx.bridge.ingest(msg);
  assert.deepEqual(ctx.transport.sent.map((s) => s.text), ["haha"]);
  assert.equal(ctx.transport.reacts.length, 1);
  assert.equal(ctx.transport.reacts[0].id, msg.id);
});

test("mirror: removal (agent reaction disappears) sends an empty react", async () => {
  const ctx = await setup();
  ctx.gw.onPrompt = () => {
    ctx.gw.status = { isRunning: true, isRunningTurn: true, isComposingMessage: false };
    const prompt = ctx.gw.entries.findLast((e) => e.kind === "message");
    setTimeout(() => { prompt.reactions = [{ emoji: "👍", by: AGENT }]; }, 20);
    setTimeout(() => { prompt.reactions = [{ emoji: "😂", by: "me" }]; ctx.gw.reply("ok"); ctx.gw.status = { isRunning: false, isRunningTurn: false, isComposingMessage: false }; }, 120);
  };
  await ctx.bridge.ingest(mention("x"));
  assert.deepEqual(ctx.transport.reacts.map((r) => r.emoji), ["👍", ""]);
});

test("mirror: mirrorAgentReactions false (global or group) sends nothing", async () => {
  const off = await setup({ extra: { mirrorAgentReactions: false } });
  agentReacts(off, "👍", { text: "NO_WHATSAPP_REPLY" });
  await off.bridge.ingest(mention("y"));
  assert.equal(off.transport.reacts.length, 0);
  const grp = await setup({ groups: [{ jid: GROUP, name: "PJ Boys", agent: AGENT, mirrorAgentReactions: false }] });
  agentReacts(grp, "👍", { text: "[[react:👍]]" });
  await grp.bridge.ingest(mention("y"));
  assert.equal(grp.transport.reacts.length, 0);
  assert.equal(grp.transport.sent.length, 0, "token is never posted as text");
});

test("mirror: a react failure or hang does not block the turn", async () => {
  const ctx = await setup({ extra: { reactTimeoutMs: 50 } });
  ctx.transport.sendReaction = () => new Promise(() => {});
  agentReacts(ctx, "👍", { text: "reply" });
  await ctx.bridge.ingest(mention("z"));
  assert.deepEqual(ctx.transport.sent.map((s) => s.text), ["reply"]);
  assert.ok(ctx.log.lines?.some?.((l) => /Reaction failed/.test(l)) ?? true);
});

test("mirror: react rate limit per chat", async () => {
  const ctx = await setup({ extra: { reactPerChatPerMinute: 1 } });
  for (const t of ["a", "b"]) {
    ctx.gw.onPrompt = undefined;
    ctx.gw.onPrompt = () => { ctx.gw.reply("[[react:✅]]"); };
    await ctx.bridge.ingest(mention(t));
  }
  assert.equal(ctx.transport.reacts.length, 1);
  assert.equal(ctx.transport.sent.length, 0);
});

test("fallback token: [[react:<emoji>]] reacts on the trigger, posts no text", async () => {
  const ctx = await setup();
  replyAfter(ctx, 20, "[[react:👌]]");
  const msg = mention("noted?");
  await ctx.bridge.ingest(msg);
  assert.equal(ctx.transport.sent.length, 0);
  assert.deepEqual(ctx.transport.reacts.map((r) => [r.id, r.emoji]), [[msg.id, "👌"]]);
  assert.equal(parseReactToken(" [[react:👍]] "), "👍");
  assert.equal(parseReactToken("[[react:]]"), "");
  assert.equal(parseReactToken("[[react:👍]] thanks"), undefined);
  assert.equal(parseReactToken("[[react:ok]]"), undefined);
});

test("mirror: key without cached raw uses the last [whatsapp-from] sender (batch = latest message)", async () => {
  const ctx = await setup();
  const content = "[whatsapp-batch] count=2\n[whatsapp-from] jid=111@lid\nhi\n[whatsapp-from] jid=222@lid\nyo";
  assert.equal(lastSenderJid(content), "222@lid");
  const key = ctx.bridge.reactionKeyFor(GROUP, `whatsapp:${GROUP}:LASTID:batch2`, content);
  assert.deepEqual(key, { remoteJid: GROUP, id: "LASTID", fromMe: false, participant: "222@lid" });
  assert.equal(ctx.bridge.reactionKeyFor(GROUP, `whatsapp:${GROUP}:R9:react`, content), undefined, "reaction turns are never reacted to");
});
