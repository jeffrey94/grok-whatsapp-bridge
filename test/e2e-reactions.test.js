/**
 * Offline end-to-end: mock Baileys events -> BaileysTransport (fake socket) ->
 * normalize -> WhatsAppBridge -> real GrokClient over HTTP -> loopback MOCK
 * gateway -> scripted agent reply -> fake socket sendMessage.
 * Variant with mirrorAgentReactions ON (regression for the 2026-10-11 react rollout).
 * Nothing here contacts WhatsApp or the real Grok gateway on :1340.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APPROVAL_NOTICE, WhatsAppBridge } from "../src/bridge.js";
import { GROUP_ALL_HINT } from "../src/core/chat-policy.js";
import { LoopGuard } from "../src/core/loop-guard.js";
import { ChatRouter } from "../src/core/routing.js";
import { GrokClient } from "../src/grok-client.js";
import { JsonStateStore } from "../src/state.js";
import { BaileysTransport } from "../src/whatsapp/baileys-adapter.js";
import { StatusFile } from "../src/whatsapp/status.js";
import { fakeAuthStateFactory, fakeSocketFactory, recordingLog, waitFor, writePairedCreds } from "./helpers/fake-baileys.js";
import { startMockGateway } from "./helpers/mock-gateway.js";

const OWNER = "60123456789@s.whatsapp.net";
const QUOTES = "120363000000000001@g.us";
const JOBS = "120363000000000002@g.us";
const BOT_LID = "99999999999999@lid";

function behavior(prompt) {
  if (/needs approval/.test(prompt)) return [{ approval: true }, { text: "done after approval" }];
  if (/three replies/.test(prompt)) return [{ text: "one" }, { text: "two" }, { text: "three" }];
  if (/send the pdf/.test(prompt)) return [{ text: "Here is your **quote**" }, { file: { name: "QT-2026-0001.pdf", bytes: "%PDF-1.4 fake" } }];
  if (/stock arrived|be quiet/.test(prompt)) return [{ text: "NO_WHATSAPP_REPLY" }];
  if (/telegram-silent/.test(prompt)) return [{ text: "NO_TELEGRAM_REPLY" }];
  const photos = /\[photos attached: (\d+)\]/.exec(prompt);
  if (photos) return [{ text: `Got ${photos[1]} photos` }];
  if (/voice note attached/.test(prompt)) return [{ text: "Heard you" }];
  if (/ping/.test(prompt)) return [{ text: "pong" }];
  return [{ text: "ok" }];
}

async function setup({ limits = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-e2e-"));
  const authDir = path.join(dir, "auth");
  writePairedCreds(authDir);
  const gateway = await startMockGateway({
    agents: [
      { id: "agent-default", name: "Chief of Staff" },
      { id: "agent-quotes", name: "Quotes" },
      { id: "agent-jobs", name: "Job reports" },
    ],
    behavior,
  });
  const log = recordingLog();
  const state = new JsonStateStore(path.join(dir, "state", "bridge-state.json"));
  await state.load();
  const router = new ChatRouter({
    defaultAgent: "agent-default",
    dms: [{ id: "+60123456789" }],
    groups: [
      { jid: QUOTES, name: "Quotes", agent: "agent-quotes", mode: "mention" },
      { jid: JOBS, name: "Jobs", agent: "agent-jobs", mode: "all", mirrorAgentReactions: true },
    ],
  });
  const guard = new LoopGuard(limits);
  const makeSocket = fakeSocketFactory({
    groups: {
      [QUOTES]: { id: QUOTES, subject: "Acme Quotes" },
      [JOBS]: { id: JOBS, subject: "Field Jobs" },
    },
  });
  let bridge;
  const transport = new BaileysTransport({
    authDir,
    groups: [{ jid: QUOTES }, { jid: JOBS }],
    log,
    status: new StatusFile(path.join(dir, "state", "status.json")),
    onEvent: (event) => bridge.ingest(event),
    makeSocket,
    authStateFactory: fakeAuthStateFactory(),
    downloader: async (raw) => Buffer.from(`media:${raw.key.id}`),
  });
  const grok = new GrokClient(gateway.url, gateway.token, { pollIntervalMs: 20, replyTimeoutMs: 5_000 });
  bridge = new WhatsAppBridge({
    grok, state, router, guard, transport, log,
    options: { mirrorAgentReactions: true, sendDelayMs: 0, stableReplyMs: 60, bundling: { albumDebounceMs: 80, burstWindowMs: 150, maxWaitMs: 1_500, maxItems: 10 } },
  });
  void transport.start();
  await waitFor(() => makeSocket.sockets.length === 1);
  const sock = makeSocket.sockets[0];
  sock.open();
  await waitFor(() => transport.connected && transport.chatName(QUOTES) === "Acme Quotes");
  const idle = async () => {
    await new Promise((r) => setTimeout(r, 50));
    await bridge.drain();
  };
  const close = async () => {
    await transport.stop();
    await gateway.close();
  };
  return { dir, gateway, log, state, bridge, transport, sock, idle, close };
}

const now = () => Math.floor(Date.now() / 1000);
const dm = (id, text) => ({ key: { remoteJid: OWNER, id, fromMe: false }, pushName: "Owner", messageTimestamp: now(), message: { conversation: text } });
const groupText = (chat, id, text, { mention = false, participant = "123456789012345@lid", alt = "60177777777@s.whatsapp.net", name = "Ali" } = {}) => ({
  key: { remoteJid: chat, id, participant, participantAlt: alt, fromMe: false },
  pushName: name,
  messageTimestamp: now(),
  message: { extendedTextMessage: { text, ...(mention ? { contextInfo: { mentionedJid: [BOT_LID] } } : {}) } },
});
const dmImage = (id, caption) => ({ key: { remoteJid: OWNER, id }, pushName: "Owner", messageTimestamp: now(), message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000, ...(caption ? { caption } : {}) } } });

test("reactions on: inbound group text is accepted and gets Prompt sent + reply", async () => {
  const ctx = await setup();
  try {
    ctx.sock.deliver([groupText(JOBS, "R1", "ping from the group")]);
    await waitFor(() => ctx.log.lines.some((l) => l.includes(`Inbound accepted chat=${JOBS} msg=R1`)), 3_000);
    await waitFor(() => ctx.log.lines.some((l) => l.includes(`Prompt sent chat=${JOBS} msg=R1`)), 3_000);
    await waitFor(() => ctx.sock.sent.length >= 1, 5_000);
    await ctx.idle();
    assert.equal(ctx.gateway.prompts[0].agentId, "agent-jobs");
    assert.ok(ctx.sock.sent.some((s) => s.jid === JOBS || s.chatId === JOBS || JSON.stringify(s).includes("pong")));
  } finally {
    await ctx.close();
  }
});
