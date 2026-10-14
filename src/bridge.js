import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { HANDOFF_NOTICE, isTopLevelPromptEntry } from "./grok-client.js";
import {
  DEFAULT_SILENT_TOKENS,
  FAQ_ONLY_BLOCKED_REPLY,
  GROUP_ALL_HINT,
  SCHEDULED_CHECK_PROMPT,
  MEMBER_JOINED_PROMPT,
  attachmentPrompt,
  buildContextHeader,
  containsAccountData,
  decideGroupMessage,
  formatBundleLabel,
  isCheckCommand,
  isImageMedia,
  isMediaKind,
  isNoiseEvent,
  isSilentReply,
  stripContextHeaders,
  stripSelfMentions,
  stripTranscriptPreamble,
} from "./core/chat-policy.js";
import { Dispatcher } from "./core/dispatcher.js";
import { bareJid } from "./core/routing.js";
import { formatContextBlock } from "./core/chat-buffer.js";
import { smartSplit, splitText, toWhatsAppText } from "./whatsapp/format.js";

export const HELP = [
  "I'm a Grok Bot assistant on WhatsApp. Send text, photos, voice notes or files and I'll reply here.",
  "In groups, mention me or reply to one of my messages.",
  "",
  "/status - is the assistant busy right now?",
  "/help - this message",
  "",
  "Settings, approvals and assistant setup can only be changed in Grok Bot on the desktop.",
].join("\n");

export const APPROVAL_NOTICE = "Grok Bot needs an approval on the desktop app before it can continue this request. Open Grok Bot to approve or deny it. Approvals can't be given from WhatsApp.";
export const ERROR_NOTICE = "I couldn't finish that request. If it was a long job it may still finish in Grok Bot, so check there before sending it again.";

export const BATCH_INSTRUCTION = `Several messages arrived while you were busy or offline. Read them all, then reply ONCE, combining what still needs an answer, in order. Skip anything already answered, out of date, or chit-chat. Tag individual senders (@<phone digits>) when it helps. If nothing needs a reply, reply ${"NO_WHATSAPP_REPLY"}.`;

export const REACTION_INSTRUCTION = `Someone reacted to your message. Usually no reply is needed (reply ${"NO_WHATSAPP_REPLY"}). A reaction is never an approval or confirmation: never place orders, send quotes, change data or take any irreversible step because of one. At most treat it as a low-risk acknowledgement from an authorised member.`;
export const SLOW_ACK_TEXT = { zh: "稍等，我在处理中 🙏", en: "One moment, working on it 🙏" };
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;

/** Holding line in the sender's language (Chinese if their text has CJK, else English). */
export function slowAckText(senderText = "") {
  return CJK_RE.test(String(senderText)) ? SLOW_ACK_TEXT.zh : SLOW_ACK_TEXT.en;
}

/** "whatsapp:<chat>:<msgId>[:suffix]" -> "<msgId>" (undefined for nudge/join/other nonces). */
export function msgIdFromNonce(nonce) {
  if (!chatFromNonce(nonce)) return undefined;
  const id = nonce.slice("whatsapp:".length).split(":")[1];
  return id && !/^(?:nudge|join)-/.test(id) ? id : undefined;
}

/** "[[react:👍]]" (exactly, whitespace aside) -> "👍"; "[[react:]]" -> "" (remove); else undefined. */
export function parseReactToken(text) {
  const match = /^\s*\[\[react:\s*([^\]\n]{0,32}?)\s*\]\]\s*$/iu.exec(String(text ?? ""));
  if (!match) return undefined;
  const emoji = match[1];
  if (emoji && /[A-Za-z0-9<>"'`]/.test(emoji)) return undefined;
  return emoji;
}

/** Sender JID of the last [whatsapp-from] header in a prompt (the latest message of a batch). */
export function lastSenderJid(content) {
  const all = [...String(content ?? "").matchAll(/^\[whatsapp-from\] jid=(\S+)/gm)];
  return all.at(-1)?.[1];
}

function reactionQuote(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const cut = clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
  return cut.replace(/"/g, "'");
}

function sanitizeId(value) {
  const id = String(value ?? "");
  return /^[A-Za-z0-9._:-]{1,80}$/.test(id) ? id : "unknown";
}

const ATTACHMENT_LIMIT = 20 * 1024 * 1024;
const ATTACHMENT_READ_ATTEMPTS = 5;
const APPROVAL_ENTRY_TYPES = new Set(["auto-review-approval", "local-tool-permission"]);

const MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  md: "text/markdown",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

export function guessMimeType(filename = "") {
  const extension = String(filename).toLowerCase().split(".").at(-1);
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** Keep user-supplied file names harmless: no paths, control chars or huge names. */
export function safeFilename(name, fallback = "whatsapp-file.bin") {
  if (typeof name !== "string") return fallback;
  const base = name.split(/[\\/]/).at(-1)
    .replace(/[\u0000-\u001F\u007F"<>|:*?]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (!base) return fallback;
  return base.length > 120 ? `${base.slice(0, 100)}${base.slice(base.lastIndexOf("."), base.length).slice(0, 20)}` : base;
}

function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)}-${count + 1}${name.slice(dot)}` : `${name}-${count + 1}`;
  });
}

/** "whatsapp:<chatJid>:<msgId>[:bN]" -> "<chatJid>" (only for prompts this bridge sent). */
export function chatFromNonce(nonce) {
  if (typeof nonce !== "string" || !nonce.startsWith("whatsapp:")) return undefined;
  const chat = nonce.slice("whatsapp:".length).split(":")[0];
  return bareJid(chat) === chat && /@(?:g\.us|s\.whatsapp\.net|lid)$/.test(chat) ? chat : undefined;
}

/** "t310s655" / "t310u" -> "t310" (gateway transcript ids); undefined for other id shapes. */
export function transcriptTurnId(id) {
  const match = /^(t\d+)(?:s\d+|u)$/.exec(typeof id === "string" ? id : "");
  return match?.[1];
}

function newTurnState() {
  return { quoteUsed: false, handoffSent: false, sentParts: 0, handled: 0, stopped: false };
}

function normalizeName(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

/**
 * WhatsApp <-> Grok Bot bridge core. Platform glue lives in the transport:
 *   transport.selfIds() -> string[]              own bare JIDs (PN and LID)
 *   transport.sendText(chatId, text, { quoted })
 *   transport.sendFile(chatId, { bytes, filename, mimetype }, { quoted })
 *   transport.downloadMedia(event) -> Uint8Array
 *   transport.setTyping?(chatId, on)   transport.chatName?(chatId)
 *   transport.wasSentByUs?(messageId)
 */
export class WhatsAppBridge {
  constructor({ grok, state, router, guard, transport, log = console, options = {}, journal, chatBuffer }) {
    this.grok = grok;
    // Tag-mode groups: rolling buffer of unforwarded messages (src/core/chat-buffer.js).
    this.chatBuffer = chatBuffer;
    // Optional write-ahead journal of accepted inbound messages (src/journal.js).
    this.journal = journal;
    this.state = state;
    this.router = router;
    this.guard = guard;
    this.transport = transport;
    this.log = log;
    this.options = {
      silentTokens: DEFAULT_SILENT_TOKENS,
      maxMessageAgeSec: 600,
      // Recent offline catch-up messages (event.catchUp) may be up to this old.
      catchUpMaxAgeMs: 20 * 60_000,
      sendDelayMs: 1_200,
      typingIndicator: true,
      smartSplit: { maxParts: 3, minChars: 320, targetChars: 280 },
      // quoteInDms: unset = follow quoteReplies (true/false overrides for DMs).
      replyTimeoutMs: 10 * 60_000,
      // How long one turn may hold its agent's queue after the prompt was sent.
      // After that the reply keeps streaming in the background (same delivery
      // locks, so nothing is sent twice) and the next message is handled. 0 = never release.
      turnQueueHoldMs: 120_000,
      // Backlog batching: when a chat's next turn starts with batchMinCount or more
      // messages waiting (or the oldest waited batchMaxAgeMs), they go to the agent
      // as ONE catch-up prompt with a [whatsapp-batch] header.
      batchBacklog: true,
      batchMinCount: 2,
      batchMaxAgeMs: 60_000,
      // Max wait for a rate-limit slot before an agent reply part is dropped.
      rateWaitMaxMs: 75_000,
      // Agent messages that arrive after their prompt's turn (a background task
      // finishing, or after a reply timeout) still go to the chat the agent last
      // served, for this long after that chat's prompt. 0 disables it.
      lateDeliveryWindowMs: 60 * 60_000,
      lateDeliveryPollMs: 3_000,
      // A turn is followed by the late poller only while it is pending (prompt sent,
      // final reply not posted) and for at most this long after its live wait ended.
      lateMaxAgeMs: 10 * 60_000,
      // After a turn completes, keep watching its conversation for new agent
      // entries (e.g. a SendToUser from a background-completion wake) for this
      // long; each newly delivered entry extends the window. 0 disables it.
      followUpWindowMs: 10 * 60_000,
      // Idle follow-up polling backs off from lateDeliveryPollMs up to this.
      followUpPollMaxMs: 30_000,
      // Late duplicate-text guard: full message text (all bubbles) already posted
      // to the chat within this window is not posted again; short texts are exempt.
      dupTextWindowMs: 10 * 60_000,
      dupTextMinChars: 25,
      // Retry a prompt once when its reply wait timed out after a host pause.
      pauseRetry: true,
      // Per-agent backoff for transient gateway errors (HTTP 5xx, timeouts) in the poller.
      latePollMaxBackoffMs: 60_000,
      streamReplies: true,
      attachmentReadBackoffMs: (attempt) => 300 + (attempt * 125),
      // New-member greeting (groups with greetNewMembers): collect adds for this long, then greet once.
      greetDebounceMs: 8_000,
      // The same person is not greeted twice in this window (re-adds, replayed join events).
      greetRepeatMs: 6 * 60 * 60_000,
      // Quote the triggering message on replies (groups follow their quoteReplies; DMs
      // follow quoteInDms when set, else this).
      quoteReplies: true,
      // Re-send "composing" this often while a turn runs; 0 = only at the start.
      typingRefreshMs: 10_000,
      // Groups with slowAck: true get ONE holding line after this long with nothing sent.
      slowAckMs: 25_000,
      // Forward reactions on the bot's own messages to the agent.
      forwardReactions: false,
      // Mirror the agent's own reactions (ReactToMessage, or a [[react:<emoji>]] reply) to WhatsApp.
      mirrorAgentReactions: false,
      reactTimeoutMs: 8_000,
      reactPerChatPerMinute: 10,
      now: () => Date.now(),
      ...options,
    };
    this.dispatcher = new Dispatcher(this, {
      bundling: options.bundling,
      log,
      now: () => this.options.now(),
      ...(this.options.batchBacklog ? {
        batching: { minCount: this.options.batchMinCount, maxAgeMs: this.options.batchMaxAgeMs },
      } : {}),
    });
    this.notifiedApprovals = new Set();
    this.agentLocks = new Map();
    this.activeTurns = new Map();
    this.pendingRecovery = new Map();
    // clientNonce -> sender access ("full" | "account" | "faq-only") for groups with a member list.
    this.turnAccess = new Map();
    this.lastScheduledCheck = new Map();
    // group jid -> { members: Map, timer } (pending greeting); "group|member" -> greeted-at.
    this.pendingGreetings = new Map();
    this.greeted = new Map();
    // msgId -> accepted-at: inbound messages accepted but not yet finished (watchdog).
    this.inflight = new Map();
    // msgId -> raw WAMessage of recent accepted inbound messages (quoting late replies).
    this.inboundRaw = new Map();
    // "agentId:entryId" -> emoji last mirrored to WhatsApp ("" = removed).
    this.mirroredReactions = new Map();
    // chatId -> timestamps of recent reacts (own light limit, separate from message limits).
    this.reactTimes = new Map();
    // agentId -> { failures, nextAt } (late poller backoff with jitter).
    this.latePollBackoff = new Map();
    // agentId -> { idle, nextAt } (cheap backoff while only follow-up watches are open).
    this.followUpIdle = new Map();
    // clientNonce -> { prompt, attachmentPaths, attachmentNames } (one pause retry per turn).
    this.turnPrompts = new Map();
    this.metrics = { latePolls: 0, latePollErrors: 0, lateSkipped: 0, lateExpired: 0, promptsReused: 0, journalReplayed: 0 };
  }

  mirrorReactionsEnabled(chatId) {
    const group = this.router.groupFor?.(chatId);
    return (group?.mirrorAgentReactions ?? this.options.mirrorAgentReactions) === true;
  }

  /** WhatsApp key of the inbound message behind a bridge prompt (latest message for batches). */
  reactionKeyFor(chatId, clientNonce, promptContent) {
    if (typeof clientNonce !== "string" || /:react$/.test(clientNonce)) return undefined;
    const msgId = msgIdFromNonce(clientNonce);
    if (!msgId || chatFromNonce(clientNonce) !== chatId) return undefined;
    const raw = this.inboundRaw.get(msgId);
    if (raw?.key?.id) return raw.key;
    const key = { remoteJid: chatId, id: msgId, fromMe: false };
    if (chatId.endsWith("@g.us")) {
      const participant = lastSenderJid(promptContent);
      if (!participant) return undefined;
      key.participant = participant;
    }
    return key;
  }

  /** Send one react, rate-limited per chat and time-boxed. Never throws. */
  async sendReactionSafe(chatId, key, emoji, label) {
    if (!this.transport.sendReaction) return false;
    const now = this.options.now();
    const times = (this.reactTimes.get(chatId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= this.options.reactPerChatPerMinute) {
      this.log.warn(`Reaction dropped chat=${chatId} reason=react-rate ${label}`);
      return false;
    }
    times.push(now);
    this.reactTimes.set(chatId, times);
    let timer;
    try {
      await Promise.race([
        this.transport.sendReaction(chatId, key, emoji),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("react timeout")), this.options.reactTimeoutMs); }),
      ]);
      this.log.info(`Reacted chat=${chatId} msg=${key.id} emoji=${emoji || "(removed)"} ${label}`);
      return true;
    } catch (error) {
      this.log.warn(`Reaction failed chat=${chatId} msg=${key.id} reason=${error.message} ${label}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mirror the agent's reaction on a bridge prompt entry (reactions[].by === agent id). */
  async mirrorAgentReaction(agent, clientNonce, entry, chatId, turn) {
    if (!entry?.id || !chatId || !this.mirrorReactionsEnabled(chatId)) return;
    const mine = Array.isArray(entry.reactions) ? entry.reactions.filter((r) => r?.by === agent.id && typeof r.emoji === "string") : [];
    const mapKey = `${agent.id}:${entry.id}`;
    const previous = this.mirroredReactions.get(mapKey);
    const emoji = mine.at(-1)?.emoji ?? "";
    if (emoji === (previous ?? "")) return;
    const key = this.reactionKeyFor(chatId, clientNonce, entry.content);
    this.mirroredReactions.set(mapKey, emoji);
    if (this.mirroredReactions.size > 2000) this.mirroredReactions.delete(this.mirroredReactions.keys().next().value);
    if (!key) {
      this.log.info(`Reaction not mirrored chat=${chatId} entry=${entry.id} reason=no-message-key`);
      return;
    }
    turn?.progress?.settle();
    await this.sendReactionSafe(chatId, key, emoji, `entry=${entry.id} source=agent`);
  }

  rememberInbound(event) {
    if (!event?.id || !event.raw || event.kind === "reaction") return;
    this.inboundRaw.delete(event.id);
    this.inboundRaw.set(event.id, event.raw);
    if (this.inboundRaw.size > 1000) this.inboundRaw.delete(this.inboundRaw.keys().next().value);
  }

  /** Is this reaction forwardable? Bot's own message, emoji present, switch on. */
  checkReaction(event, route) {
    const enabled = route?.group?.forwardReactions ?? this.options.forwardReactions;
    if (enabled !== true) return { ok: false, reason: "reactions-off" };
    const reaction = event.reaction ?? {};
    if (!reaction.emoji || !String(reaction.emoji).trim()) return { ok: false, reason: "reaction-removed" };
    if (!reaction.targetId) return { ok: false, reason: "reaction-no-target" };
    const selfIds = this.selfIds();
    const onBot = this.transport.wasSentByUs?.(reaction.targetId) === true
      || (reaction.targetParticipant && selfIds.includes(reaction.targetParticipant));
    if (!onBot) return { ok: false, reason: "reaction-not-on-bot-message" };
    return { ok: true };
  }

  reactionBody(event) {
    const reaction = event.reaction ?? {};
    const known = this.transport.sentTextOf?.(reaction.targetId);
    const emoji = String(reaction.emoji).replace(/\s+/g, "").slice(0, 16);
    const line = `[whatsapp-reaction] emoji=${emoji} on_bot_msg=${sanitizeId(reaction.targetId)}${known ? ` on_text="${reactionQuote(known)}"` : ""}`;
    return `${line}\n${REACTION_INSTRUCTION}`;
  }

  /** Age of the oldest accepted inbound message still being handled (0 when idle). */
  oldestInflightMs() {
    let oldest = Infinity;
    for (const at of this.inflight.values()) oldest = Math.min(oldest, at);
    return Number.isFinite(oldest) ? Math.max(0, this.options.now() - oldest) : 0;
  }

  /**
   * Let a live turn hold the agent queue for at most turnQueueHoldMs. The turn
   * itself keeps running; its errors are logged/notified when they happen.
   */
  async holdQueue(turnPromise, { chatId, msgId, onLateError } = {}) {
    const holdMs = this.options.turnQueueHoldMs;
    if (!(holdMs > 0)) return turnPromise;
    let timer;
    const released = Symbol("released");
    const result = await Promise.race([
      turnPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(released), holdMs); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
    if (result !== released) return result;
    this.log.warn(`Turn still running after ${holdMs}ms chat=${chatId} msg=${msgId}; releasing the queue, reply continues in background`);
    turnPromise.catch((error) => onLateError?.(error));
    return { released: true };
  }

  rememberTurnAccess(clientNonce, access) {
    if (!access) return;
    this.turnAccess.set(clientNonce, access);
    if (this.turnAccess.size > 500) this.turnAccess.delete(this.turnAccess.keys().next().value);
  }

  /**
   * Access level of the sender behind a turn: in memory, else persisted with the
   * late/follow-up watch. Unknown in a group that uses the member list (e.g.
   * after a restart) fails closed to faq-only.
   */
  accessFor(agentId, clientNonce, chatId) {
    const known = clientNonce ? this.turnAccess.get(clientNonce) : undefined;
    if (known) return known;
    const saved = clientNonce ? this.state.getLateTurn?.(agentId, clientNonce)?.access : undefined;
    if (saved) return saved === "none" ? undefined : saved;
    const group = this.router.groupFor?.(chatId);
    return group?.members && group.faqOnlyGuard !== false ? "faq-only" : undefined;
  }

  /** Serialize every delivery for one agent (live turn + late follower) so nothing is sent twice. */
  withAgentLock(agentId, operation) {
    const previous = this.agentLocks.get(agentId) ?? Promise.resolve();
    const task = previous.then(operation);
    const settled = task.catch(() => {});
    this.agentLocks.set(agentId, settled);
    void settled.then(() => {
      if (this.agentLocks.get(agentId) === settled) this.agentLocks.delete(agentId);
    });
    return task;
  }

  beginTurn(agentId) {
    this.activeTurns.set(agentId, (this.activeTurns.get(agentId) ?? 0) + 1);
  }

  endTurn(agentId) {
    const count = (this.activeTurns.get(agentId) ?? 1) - 1;
    if (count > 0) this.activeTurns.set(agentId, count);
    else this.activeTurns.delete(agentId);
  }

  replyWindowMs() {
    return Math.max(this.guard.limits?.replyWindowMs ?? 0, this.options.lateDeliveryWindowMs || 0);
  }

  selfIds() {
    return (this.transport.selfIds?.() ?? []).filter(Boolean);
  }

  /** Entry point for every normalized inbound WhatsApp event. */
  ingest(event, options = {}) {
    const verdict = this.accept(event);
    if (!verdict.ok) {
      this.log.info(`Drop inbound reason=${verdict.reason} chat=${event?.chatId ?? "none"} msg=${event?.id ?? "none"}`);
      return Promise.resolve({ dropped: verdict.reason });
    }
    const key = `${event.chatId}|${event.id}`;
    if (this.inflight.has(key)) {
      // e.g. a journal replay and a WhatsApp catch-up delivering the same message.
      this.log.info(`Drop inbound reason=duplicate-inflight chat=${event.chatId} msg=${event.id}`);
      return Promise.resolve({ dropped: "duplicate-inflight" });
    }
    this.log.info(`Inbound accepted chat=${event.chatId} msg=${event.id} kind=${event.kind} route=${verdict.route.kind}${event.replayed ? " replayed=yes" : ""}`);
    const acceptedAt = this.options.now();
    if (event && typeof event === "object" && !Number.isFinite(event.receivedAt)) event.receivedAt = acceptedAt;
    // Write-ahead: on disk (fsync'd) before it enters the in-memory queue.
    if (this.journal && !this.journal.has(key)) this.journal.add(event, acceptedAt);
    this.rememberInbound(event);
    this.inflight.set(key, acceptedAt);
    const task = this.dispatcher.dispatch(event, options);
    void Promise.resolve(task).then(
      () => this.journal?.remove(key),
      (error) => {
        // Shutdown (SIGTERM) or abort: keep it in the journal; it is replayed at the next start.
        if (options.signal?.aborted || error?.name === "AbortError") return;
        this.journal?.remove(key);
      },
    ).finally(() => this.inflight.delete(key)).catch(() => {});
    return task;
  }

  /** Per-message checks before bundling: own/bot/echo, allowlist, staleness, unsupported kinds. */
  accept(event) {
    const inbound = this.guard.checkInbound(event, this.selfIds());
    if (!inbound.ok) return inbound;
    const route = this.router.route(event);
    if (!route.ok) return route;
    const nowSec = this.options.now() / 1000;
    const maxAgeSec = event.catchUp
      ? Math.max(this.options.maxMessageAgeSec, (this.options.catchUpMaxAgeMs || 0) / 1000)
      : this.options.maxMessageAgeSec;
    if (event.timestamp && maxAgeSec > 0 && nowSec - event.timestamp > maxAgeSec) {
      return { ok: false, reason: event.catchUp ? "catchup-too-old" : "stale-message" };
    }
    if (event.kind === "reaction") {
      const reaction = this.checkReaction(event, route);
      return reaction.ok ? { ok: true, route } : reaction;
    }
    if (route.kind === "dm" && event.kind !== "text" && !isMediaKind(event.kind)) {
      return { ok: false, reason: `unsupported-kind:${event.kind}` };
    }
    return { ok: true, route };
  }

  queueKeyFor(event) {
    const route = this.router.route(event);
    return route.ok ? route.queueKey : `chat:${event?.chatId ?? "unknown"}`;
  }

  classifyForBundling(event) {
    const route = this.router.route(event);
    if (!route.ok || !event.sender?.jid) return undefined;
    const senderKey = `${event.chatId}|${event.sender.jid}`;
    const text = (event.text ?? "").trim();
    if (event.kind === "image" || (event.kind === "document" && isImageMedia(event.media))) {
      return { senderKey, role: "media", album: event.album === true };
    }
    if (event.kind === "text" && text && !text.startsWith("/")) return { senderKey, role: "text" };
    return { senderKey, role: "other" };
  }

  /** Commands (/help, /status, check pending, …) always run as their own turn. */
  batchable(unit) {
    const items = Array.isArray(unit?.bundled) && unit.bundled.length ? unit.bundled : [unit];
    return !items.some((item) => {
      const text = stripContextHeaders(item?.text ?? "").trim();
      return text.startsWith("/") || isCheckCommand(text);
    });
  }

  resolveAgent(wanted, agents) {
    const target = String(wanted ?? "").trim();
    return agents.find((agent) => agent.id === target)
      || agents.find((agent) => normalizeName(agent.name) === normalizeName(target));
  }

  quotedFor(route, primary) {
    if (!primary || primary.kind === "reaction") return undefined; // never quote a reaction
    const raw = primary.raw ?? this.inboundRaw.get(primary.id);
    return this.quoteAllowed(route) ? raw ?? undefined : undefined;
  }

  quoteAllowed(route) {
    if (this.options.quoteReplies === false) return false;
    if (route?.kind === "group") return route.group?.quoteReplies !== false;
    return this.options.quoteInDms ?? this.options.quoteReplies !== false;
  }

  /**
   * Quote target for a late/recovered reply: the primary inbound message of the
   * turn identified by clientNonce (persisted with the pending turn), if still
   * cached. Unknown -> undefined (send without a quote, never the latest message).
   */
  quotedForNonce(chatId, clientNonce, agentId) {
    if (typeof clientNonce !== "string" || !clientNonce || chatFromNonce(clientNonce) !== chatId) return undefined;
    const saved = agentId ? this.state.getTurnQuote?.(agentId, clientNonce) : undefined;
    if (saved && saved.chatId !== chatId) return undefined;
    const msgId = saved?.msgId ?? msgIdFromNonce(clientNonce);
    let raw = msgId ? this.inboundRaw.get(msgId) : undefined;
    const isGroup = chatId.endsWith("@g.us");
    if (!raw && msgId && saved?.text && (!isGroup || saved.participant)) {
      // Persisted copy of the question (survives restarts): minimal quote stub.
      raw = {
        key: { remoteJid: chatId, id: msgId, fromMe: false, ...(isGroup ? { participant: saved.participant } : {}) },
        message: { conversation: saved.text },
      };
    }
    if (!raw) return undefined;
    const group = this.router.groupFor?.(chatId);
    return this.quoteAllowed(group ? { kind: "group", group } : { kind: "dm" }) ? raw : undefined;
  }

  /** Late post: quote its own question; if that is impossible, a short "Re: …" line. */
  lateQuote(chatId, clientNonce, agentId) {
    const quoted = this.quotedForNonce(chatId, clientNonce, agentId);
    if (quoted || !clientNonce) return { quoted };
    const group = this.router.groupFor?.(chatId);
    if (!this.quoteAllowed(group ? { kind: "group", group } : { kind: "dm" })) return {};
    const text = this.state.getTurnQuote?.(agentId, clientNonce)?.text;
    if (typeof text !== "string" || !text.trim()) return {};
    const short = text.replace(/\s+/g, " ").trim();
    return { rePrefix: `Re: "${short.length > 60 ? `${short.slice(0, 57)}…` : short}"` };
  }

  /** A single reaction on a bot message: small trusted prompt, no quote. */
  async handleReaction(event, route, options = {}) {
    const chatId = event.chatId;
    const turnGate = this.guard.takeInboundTurn(chatId, event.sender?.jid);
    if (!turnGate.ok) {
      this.log.warn(`Drop reaction reason=${turnGate.reason} chat=${chatId}`);
      return { dropped: turnGate.reason };
    }
    this.guard.openReplyWindow(chatId);
    const agents = await this.grok.listAgents(options);
    const agent = this.resolveAgent(route.agent, agents);
    if (!agent) {
      this.log.error(`Agent not found chat=${chatId} agent=${JSON.stringify(route.agent)} (check config.json)`);
      return { dropped: "agent-not-found" };
    }
    const member = route.kind === "group" && route.group?.members ? (route.member ?? null) : undefined;
    const header = buildContextHeader({
      sender: event.sender,
      chat: { jid: chatId, type: route.kind === "group" ? "group" : "dm", name: route.kind === "group" ? (this.transport.chatName?.(chatId) ?? route.group?.name) : undefined },
      replyToBot: true,
      mentioned: false,
      ...(member !== undefined ? { member } : {}),
    });
    const clientNonce = `whatsapp:${chatId}:${event.id}:react`;
    if (member !== undefined && route.group?.faqOnlyGuard !== false) this.rememberTurnAccess(clientNonce, member?.access ?? "faq-only");
    if (this.state.isPromptTurnRetired?.(agent.id, clientNonce)) return { dropped: "duplicate" };
    return this.runPromptTurn({
      input: event, options, agent, route, chatId, primary: event, quoted: undefined, clientNonce,
      showTyping: false, mediaItems: [], senderText: "", allowSlowAck: false,
      buildPrompt: () => `${header}\n\n${this.reactionBody(event)}`,
      logLabel: `Reaction turn chat=${chatId} agent=${agent.id} emoji=${event.reaction?.emoji}`,
    });
  }

  /** Every inbound event inside a turn input (single, bundle, batch of units/bundles). */
  inputEvents(input) {
    if (!input || typeof input !== "object") return [];
    if (Array.isArray(input.batch)) return input.batch.flatMap((unit) => this.inputEvents(unit));
    if (Array.isArray(input.bundled) && input.bundled.length) return input.bundled.flatMap((item) => this.inputEvents(item));
    return input.id ? [input] : [];
  }

  /**
   * Could this turn's prompt already be in the transcript? True for journal replays
   * and for messages received before the last box pause (a pause can be a VM
   * rollback that hides a prompt the lost run already sent).
   */
  mayHaveSentBefore(input) {
    const events = this.inputEvents(input);
    if (events.some((event) => event.replayed)) return true;
    const pauseAt = this.transport.lastPauseAt;
    const pauseMs = this.transport.lastPauseMs ?? 0;
    if (!Number.isFinite(pauseAt)) return false;
    return events.some((event) => Number.isFinite(event.receivedAt) && event.receivedAt <= pauseAt && event.receivedAt >= pauseAt - pauseMs - 30 * 60_000);
  }

  /** Is a prompt with this clientNonce already in the agent's transcript? (fails open) */
  async promptAlreadySent(agentId, clientNonce, options = {}) {
    try {
      const entries = await this.transcriptTail(agentId, options);
      return entries.some((entry) => isTopLevelPromptEntry(entry) && entry.clientNonce === clientNonce);
    } catch (error) {
      if (options.signal?.aborted || error?.name === "AbortError") throw error;
      this.log.warn(`Prompt dedupe check failed agent=${agentId} reason=${error.message}; sending`);
      return false;
    }
  }

  async handleEvent(input, options = {}) {
    if (Array.isArray(input?.batch)) return this.handleBatch(input, options);
    const items = Array.isArray(input?.bundled) && input.bundled.length > 1 ? input.bundled : [input];
    const primary = items[0];
    const isBundle = items.length > 1;
    const route = this.router.route(primary);
    if (!route.ok) {
      this.log.info(`Drop event reason=${route.reason} chat=${primary?.chatId ?? "none"}`);
      return { dropped: route.reason };
    }
    const chatId = primary.chatId;
    if (primary.kind === "reaction") {
      const reaction = this.checkReaction(primary, route);
      if (!reaction.ok) return { dropped: reaction.reason };
      return this.handleReaction(primary, route, options);
    }
    const selfIds = this.selfIds();
    const selfUserParts = selfIds.map((id) => id.split("@")[0]);
    const mentioned = items.some((item) => (item.mentionedJids ?? []).some((jid) => selfIds.includes(jid)));
    const replyToBot = items.some((item) => item.quoted
      && ((item.quoted.participant && selfIds.includes(item.quoted.participant))
        || this.transport.wasSentByUs?.(item.quoted.id) === true));
    const combinedText = items
      .map((item) => stripContextHeaders(item.text ?? ""))
      .filter((text) => text && text.trim())
      .join("\n\n");
    // Strip again: removing a leading @mention can expose a header-like line.
    let text = stripContextHeaders(stripSelfMentions(combinedText, selfUserParts));

    let decision = { handle: true, softForward: false, reason: "dm" };
    if (route.kind === "group") {
      decision = decideGroupMessage({
        mentioned,
        replyToBot,
        text,
        noise: items.every((item) => isNoiseEvent(item)),
        mode: route.group.mode,
        keywords: route.group.keywords,
      });
      if (!decision.handle) {
        if (decision.buffer && this.chatBuffer) {
          const added = this.chatBuffer.add(chatId, items);
          this.log.info(`Buffered group message reason=${decision.reason} chat=${chatId} items=${added} buffered=${this.chatBuffer.size(chatId)}`);
          return { dropped: decision.reason, buffered: added };
        }
        this.log.info(`Drop group message reason=${decision.reason} chat=${chatId} items=${items.length}`);
        return { dropped: decision.reason };
      }
    }
    const turnGate = this.guard.takeInboundTurn(chatId, primary.sender?.jid);
    if (!turnGate.ok) {
      this.log.warn(`Drop turn reason=${turnGate.reason} chat=${chatId}`);
      return { dropped: turnGate.reason };
    }
    this.guard.openReplyWindow(chatId);
    const quoted = this.quotedFor(route, primary);
    const mediaItems = items.filter((item) => isMediaKind(item.kind));

    const command = text.trim().toLocaleLowerCase();
    if (command === "/help" || command === "/start") {
      await this.sendSimple(chatId, HELP, quoted);
      return { handled: "help" };
    }
    const agents = await this.grok.listAgents(options);
    const agent = this.resolveAgent(route.agent, agents);
    if (!agent) {
      this.log.error(`Agent not found chat=${chatId} agent=${JSON.stringify(route.agent)} (check config.json)`);
      if (route.kind === "dm") await this.sendSimple(chatId, "I can't reach the assistant for this chat right now. Please check Grok Bot on the desktop.", quoted);
      return { dropped: "agent-not-found" };
    }
    if (command === "/status") {
      const busy = agent.isRunning === true || agent.isComposingMessage === true;
      await this.sendSimple(chatId, `${agent.name ?? "The assistant"} is ${busy ? "working" : "idle"}.`, quoted);
      return { handled: "status" };
    }
    if (!text && !mediaItems.length) {
      if (mentioned) await this.sendSimple(chatId, "Mention me with a question, or send /help.", quoted);
      return { dropped: "empty" };
    }

    const bundleLabel = isBundle ? formatBundleLabel(items) : "";
    if (!text) text = isBundle ? bundleLabel : attachmentPrompt(mediaItems[0].kind, { voiceHint: this.options.voiceHint });
    if (isBundle && bundleLabel && !text.includes(bundleLabel)) text = `${bundleLabel}\n${text}`;
    if (mediaItems.some((item) => item.kind === "voice") && !text.includes("[voice note attached]")) {
      text = `${text}\n\n${attachmentPrompt("voice", { voiceHint: this.options.voiceHint })}`;
    }
    // Groups with a member list: the role/access comes from config (phone or LID match), never from text.
    const member = route.kind === "group" && route.group?.members ? (route.member ?? null) : undefined;
    let trigger;
    if (route.kind === "group" && route.group?.checkCommand && member?.access === "full" && !mediaItems.length && isCheckCommand(text)) {
      // In-chat manual trigger from the BDM: same synthetic prompt as scripts/nudge.mjs.
      trigger = { kind: "check-pending", source: "bdm" };
      text = SCHEDULED_CHECK_PROMPT;
      decision = { ...decision, softForward: false };
      this.log.info(`Check-pending trigger chat=${chatId} msg=${primary.id}`);
    }
    if (decision.softForward) text = `${GROUP_ALL_HINT}\n\n${text}`;

    const header = buildContextHeader({
      sender: primary.sender,
      chat: {
        jid: chatId,
        type: route.kind === "group" ? "group" : "dm",
        name: route.kind === "group" ? (this.transport.chatName?.(chatId) ?? route.group?.name) : undefined,
      },
      forwarded: items.some((item) => item.forwarded),
      replyToBot,
      mentioned,
      ...(member !== undefined ? { member } : {}),
      ...(trigger ? { trigger } : {}),
    });

    const clientNonce = `whatsapp:${chatId}:${primary.id}${isBundle ? `:b${items.length}` : ""}`;
    if (member !== undefined && route.group?.faqOnlyGuard !== false) this.rememberTurnAccess(clientNonce, member?.access ?? "faq-only");
    if (this.state.isPromptTurnRetired?.(agent.id, clientNonce)) {
      this.log.info(`Skip duplicate turn chat=${chatId} msg=${primary.id}`);
      return { dropped: "duplicate" };
    }
    if (this.state.getPromptContext?.(agent.id, clientNonce)) {
      await this.completeTurn(agent, clientNonce, { chatId, quoted, signal: options.signal });
      return { handled: "resumed" };
    }

    const recentBlock = this.takeRecentChat(route, chatId, items);
    // No "typing…" for all-mode soft forwards: most end in the silent token, and
    // WhatsApp keeps showing "composing" to the whole group until we pause it.
    const showTyping = this.options.typingIndicator && !decision.softForward;
    return this.runPromptTurn({
      input, options, agent, route, chatId, primary, quoted, clientNonce, showTyping, mediaItems,
      senderText: text, allowSlowAck: !decision.softForward && !trigger,
      buildPrompt: () => `${header}\n\n${recentBlock ? `${recentBlock}\n\n` : ""}${text}`,
      logLabel: isBundle ? `Media bundle turn chat=${chatId} agent=${agent.id} messages=${items.length}` : undefined,
    });
  }

  /**
   * One catch-up turn for a chat's backlog (see Dispatcher batching). Each
   * message keeps its own trusted header; the group filter (mention / reply /
   * keyword / all-mode noise) is applied per message; one reply target (the
   * latest message kept); every merged message settles with this turn.
   */
  async handleBatch(input, options = {}) {
    const units = input.batch;
    const info = input.batchInfo ?? {};
    const selfIds = this.selfIds();
    const selfUserParts = selfIds.map((id) => id.split("@")[0]);
    const now = this.options.now();
    const kept = [];
    let chatRoute;
    for (const unit of units) {
      const items = Array.isArray(unit?.bundled) && unit.bundled.length > 1 ? unit.bundled : [unit];
      const primary = items[0];
      const route = this.router.route(primary);
      if (!route.ok) continue;
      chatRoute ??= route;
      if (primary.kind === "reaction") {
        const reaction = this.checkReaction(primary, route);
        if (!reaction.ok) {
          this.log.info(`Batch skip message reason=${reaction.reason} chat=${primary.chatId} msg=${primary.id}`);
          continue;
        }
        const member = route.kind === "group" && route.group?.members ? (route.member ?? null) : undefined;
        kept.push({
          unit, items: [primary], primary, route, mentioned: false, replyToBot: true, reaction: true,
          text: this.reactionBody(primary), mediaItems: [], decision: { handle: true, softForward: false, reason: "reaction" }, member,
        });
        continue;
      }
      const mentioned = items.some((item) => (item.mentionedJids ?? []).some((jid) => selfIds.includes(jid)));
      const replyToBot = items.some((item) => item.quoted
        && ((item.quoted.participant && selfIds.includes(item.quoted.participant))
          || this.transport.wasSentByUs?.(item.quoted.id) === true));
      const text = stripContextHeaders(stripSelfMentions(items
        .map((item) => stripContextHeaders(item.text ?? ""))
        .filter((t) => t && t.trim())
        .join("\n\n"), selfUserParts));
      const mediaItems = items.filter((item) => isMediaKind(item.kind));
      let decision = { handle: true, softForward: false, reason: "dm" };
      if (route.kind === "group") {
        decision = decideGroupMessage({
          mentioned,
          replyToBot,
          text,
          noise: items.every((item) => isNoiseEvent(item)),
          mode: route.group.mode,
          keywords: route.group.keywords,
        });
      }
      if (!decision.handle && decision.buffer && this.chatBuffer) {
        this.chatBuffer.add(primary.chatId, items);
        this.log.info(`Batch buffered message reason=${decision.reason} chat=${primary.chatId} msg=${primary.id}`);
        continue;
      }
      if (!decision.handle || (!text && !mediaItems.length)) {
        this.log.info(`Batch skip message reason=${decision.handle ? "empty" : decision.reason} chat=${primary.chatId} msg=${primary.id}`);
        continue;
      }
      const member = route.kind === "group" && route.group?.members ? (route.member ?? null) : undefined;
      kept.push({ unit, items, primary, route, mentioned, replyToBot, text, mediaItems, decision, member });
    }
    const chatId = input.chatId;
    if (!kept.length) {
      this.log.info(`Drop batch reason=nothing-to-handle chat=${chatId} messages=${info.count ?? units.length}`);
      return { dropped: "batch-empty" };
    }
    const keptCount = kept.reduce((sum, k) => sum + k.items.length, 0);
    const arrivedAt = (k) => Math.min(...k.items.map((item) => (Number.isFinite(item.receivedAt) ? item.receivedAt : now)));
    const oldestAgeMs = Math.max(0, now - Math.min(...kept.map(arrivedAt)));
    const minCount = this.options.batchMinCount ?? 2;
    const maxAgeMs = this.options.batchMaxAgeMs ?? 60_000;
    if (kept.length === 1 && keptCount < minCount && !(maxAgeMs > 0 && oldestAgeMs >= maxAgeMs)) {
      // Only one message survived the filter and it is fresh: the normal path.
      return this.handleEvent(kept[0].unit, options);
    }
    const last = kept.at(-1);
    const route = last.route;
    // Reply target: the latest kept message that is not a reaction (never quote a reaction).
    const answerTarget = [...kept].reverse().find((k) => !k.reaction);
    const turnGate = this.guard.takeInboundTurn(chatId, last.primary.sender?.jid);
    if (!turnGate.ok) {
      this.log.warn(`Drop batch reason=${turnGate.reason} chat=${chatId} messages=${keptCount}`);
      return { dropped: turnGate.reason };
    }
    this.guard.openReplyWindow(chatId);
    const quoted = answerTarget ? this.quotedFor(answerTarget.route, answerTarget.primary) : undefined;
    const agents = await this.grok.listAgents(options);
    const agent = this.resolveAgent(route.agent, agents);
    if (!agent) {
      this.log.error(`Agent not found chat=${chatId} agent=${JSON.stringify(route.agent)} (check config.json)`);
      if (route.kind === "dm") await this.sendSimple(chatId, "I can't reach the assistant for this chat right now. Please check Grok Bot on the desktop.", quoted);
      return { dropped: "agent-not-found" };
    }
    const chatName = route.kind === "group" ? (this.transport.chatName?.(chatId) ?? route.group?.name) : undefined;
    const blocks = kept.map((k, index) => {
      let body = k.text;
      if (k.items.length > 1) {
        const label = formatBundleLabel(k.items);
        if (!body) body = label;
        else if (label && !body.includes(label)) body = `${label}\n${body}`;
      }
      if (!body) body = attachmentPrompt(k.mediaItems[0].kind, { voiceHint: this.options.voiceHint });
      if (k.mediaItems.some((item) => item.kind === "voice") && !body.includes("[voice note attached]")) {
        body = `${body}\n\n${attachmentPrompt("voice", { voiceHint: this.options.voiceHint })}`;
      }
      const sentSec = Number.isFinite(k.primary.timestamp) ? k.primary.timestamp : arrivedAt(k) / 1000;
      const ageS = Math.max(0, Math.round(now / 1000 - sentSec));
      const header = buildContextHeader({
        sender: k.primary.sender,
        chat: { jid: chatId, type: route.kind === "group" ? "group" : "dm", name: chatName },
        forwarded: k.items.some((item) => item.forwarded),
        replyToBot: k.replyToBot,
        mentioned: k.mentioned,
        ...(k.member !== undefined ? { member: k.member } : {}),
      });
      const msgLine = `[whatsapp-batch-item] n=${index + 1} of=${kept.length} msg=${sanitizeId(k.primary.id)} time=${new Date(sentSec * 1000).toISOString()} age_s=${ageS}${k.mediaItems.length ? ` attachments=${k.mediaItems.length}` : ""}`;
      return `${msgLine}\n${header}\n\n${body}`;
    });
    const softForward = kept.some((k) => k.decision.softForward);
    const batchHeader = `[whatsapp-batch] count=${keptCount} oldest_age_s=${Math.round(oldestAgeMs / 1000)} reason=${info.reason === "stale" ? "stale" : "backlog"}`;
    const intro = `${batchHeader}\n${BATCH_INSTRUCTION}${softForward ? `\n${GROUP_ALL_HINT}` : ""}`;
    const mediaItems = kept.flatMap((k) => k.mediaItems);
    const clientNonce = `whatsapp:${chatId}:${last.primary.id}:batch${keptCount}`;
    // Most restrictive access among the senders wins for the FAQ-only backstop.
    const accesses = kept.filter((k) => k.member !== undefined).map((k) => k.member?.access ?? "faq-only");
    if (accesses.length && route.group?.faqOnlyGuard !== false) {
      const rank = { "faq-only": 0, account: 1, full: 2 };
      this.rememberTurnAccess(clientNonce, accesses.reduce((a, b) => ((rank[b] ?? 0) < (rank[a] ?? 0) ? b : a)));
    }
    if (this.state.isPromptTurnRetired?.(agent.id, clientNonce)) {
      this.log.info(`Skip duplicate batch chat=${chatId} msg=${last.primary.id}`);
      return { dropped: "duplicate" };
    }
    if (this.state.getPromptContext?.(agent.id, clientNonce)) {
      await this.completeTurn(agent, clientNonce, { chatId, quoted, signal: options.signal });
      return { handled: "resumed" };
    }
    const showTyping = this.options.typingIndicator && !softForward && Boolean(answerTarget);
    const recentBlock = this.takeRecentChat(route, chatId, kept.flatMap((k) => k.items));
    const result = await this.runPromptTurn({
      input: { ...input, batch: kept.map((k) => k.unit) },
      options, agent, route, chatId, primary: last.primary, quoted, clientNonce, showTyping, mediaItems,
      senderText: answerTarget?.text ?? "", allowSlowAck: !softForward && Boolean(answerTarget),
      buildPrompt: () => `${intro}\n\n${recentBlock ? `${recentBlock}\n\n` : ""}${blocks.join("\n\n")}`,
      logLabel: `Backlog batch turn chat=${chatId} agent=${agent.id} messages=${keptCount} skipped=${units.length - kept.length} oldestAgeMs=${oldestAgeMs}`,
    });
    return { ...result, batched: keptCount };
  }

  /** Tag mode: the buffered chat since the bot's last turn there, as one block (buffer cleared). */
  takeRecentChat(route, chatId, items = []) {
    if (route?.kind !== "group" || route.group?.mode !== "tag" || !this.chatBuffer) return "";
    const recent = this.chatBuffer.take(chatId, { excludeIds: items.map((item) => item?.id).filter(Boolean) });
    if (recent.length) this.log.info(`Tag mode context chat=${chatId} messages=${recent.length}`);
    return formatContextBlock(recent);
  }

  /** Upload attachments, send the prompt, record its context and hold the queue for the reply. */
  async runPromptTurn({ input, options, agent, route, chatId, primary, quoted, clientNonce, showTyping, mediaItems, buildPrompt, logLabel, senderText = "", allowSlowAck = false }) {
    if (showTyping) await this.transport.setTyping?.(chatId, true)?.catch?.(() => {});
    const progress = this.startProgress({ chatId, route, showTyping, allowSlowAck, senderText });
    let held;
    this.beginTurn(agent.id);
    try {
      const attachmentPaths = [];
      const attachmentNames = [];
      let failed = 0;
      const names = uniqueNames(mediaItems.map((item) => safeFilename(item.media?.filename)));
      for (const [index, item] of mediaItems.entries()) {
        try {
          if (item.media?.size && item.media.size > ATTACHMENT_LIMIT) throw new Error("attachment exceeds 20 MB");
          const bytes = await this.transport.downloadMedia(item);
          if (!bytes?.byteLength || bytes.byteLength > ATTACHMENT_LIMIT) throw new Error("attachment empty or exceeds 20 MB");
          attachmentPaths.push(await this.grok.uploadAttachment(agent.id, names[index], bytes, options));
          attachmentNames.push(names[index]);
        } catch (error) {
          failed += 1;
          this.log.warn(`Attachment not forwarded chat=${chatId} msg=${item.id} reason=${error.message}`);
        }
      }
      let prompt = buildPrompt();
      if (failed) prompt += `\n\n[${failed} attachment${failed === 1 ? "" : "s"} could not be downloaded from WhatsApp]`;
      if (logLabel) this.log.info(`${logLabel} attachments=${attachmentPaths.length}`);

      const questionText = typeof primary.text === "string" ? primary.text.replace(/^(?:@\d+\s*)+/, "").trim().slice(0, 200) : "";
      const participant = primary.raw?.key?.participant ?? primary.sender?.jid;
      await this.state.setTurnQuote?.(agent.id, clientNonce, {
        chatId,
        msgId: primary.id,
        ...(questionText ? { text: questionText } : {}),
        ...(chatId.endsWith("@g.us") && typeof participant === "string" ? { participant } : {}),
      }, { now: this.options.now() });
      this.turnPrompts.set(clientNonce, { prompt, attachmentPaths, attachmentNames, input, primary, route });
      if (this.turnPrompts.size > 100) this.turnPrompts.delete(this.turnPrompts.keys().next().value);
      const reuse = this.mayHaveSentBefore(input) && await this.promptAlreadySent(agent.id, clientNonce, options);
      if (reuse) {
        this.metrics.promptsReused += 1;
        this.log.warn(`Prompt reused chat=${chatId} msg=${primary.id} agent=${agent.id} (same clientNonce already in transcript; not sent again)`);
      } else {
        await this.grok.sendPrompt(agent.id, prompt, clientNonce, { ...options, attachmentPaths, attachmentNames });
      }
      const sentAt = this.options.now();
      // The agent has it now: the inbound messages leave the write-ahead journal.
      this.journal?.remove(this.inputEvents(input).map((event) => `${event.chatId}|${event.id}`));
      await this.state.setLateTurn?.(agent.id, clientNonce, { chatId, sentAt, armedAt: sentAt, reason: "live", access: this.turnAccess.get(clientNonce) ?? "none" });
      await this.state.setPromptContext(agent.id, clientNonce, {
        contextKey: clientNonce,
        clientNonce,
        origin: "whatsapp",
        chatId,
        isGroup: route.kind === "group",
        replyToMessageId: primary.id,
        createdAt: this.options.now(),
        awaitingCompletion: true,
      });
      await this.state.setLastServed?.(agent.id, {
        chatId,
        at: this.options.now(),
        ...(route.dmId ? { dmId: route.dmId } : {}),
      });
      this.log.info(`Prompt sent chat=${chatId} msg=${primary.id} agent=${agent.id} attachments=${attachmentPaths.length}`);
      held = await this.holdQueue(this.completeTurn(agent, clientNonce, { chatId, quoted, signal: options.signal, progress }), {
        chatId,
        msgId: primary.id,
        onLateError: (error) => {
          if (options.signal?.aborted || error?.name === "AbortError") return;
          this.log.error(`Background turn failed chat=${chatId} msg=${primary.id}: ${error?.message ?? error}`);
          void this.handleError(input, error, options).catch(() => {});
        },
      });
      return { handled: "prompt", clientNonce, agentId: agent.id, ...(held?.released ? { released: true } : {}) };
    } finally {
      this.endTurn(agent.id);
      // A released turn keeps its progress until completeTurn ends; otherwise stop now.
      // Never let a stuck presence update hold the agent queue (stop() does not await).
      if (!held?.released) progress.stop();
    }
  }

  /**
   * Progress while a turn runs: refresh "composing" every typingRefreshMs and,
   * for groups with slowAck: true, send ONE holding line after slowAckMs if
   * nothing was sent yet. settle() = first reply or silent reply; stop() = end.
   */
  startProgress({ chatId, route, showTyping, allowSlowAck, senderText }) {
    const timers = [];
    const state = { settled: false, stopped: false, acked: false };
    const group = route?.kind === "group" ? route.group : undefined;
    const typing = (on) => void Promise.resolve()
      .then(() => this.transport.setTyping?.(chatId, on))
      .catch(() => {});
    const refreshMs = this.options.typingRefreshMs;
    if (showTyping && refreshMs > 0 && group?.typingRefresh !== false) {
      const timer = setInterval(() => { if (!state.settled && !state.stopped) typing(true); }, refreshMs);
      timer.unref?.();
      timers.push(timer);
    }
    if (allowSlowAck && group?.slowAck === true && group?.progressBubbles !== false && this.options.slowAckMs > 0) {
      const timer = setTimeout(() => {
        if (state.settled || state.stopped || state.acked) return;
        state.acked = true;
        this.log.info(`Slow turn: holding line chat=${chatId} afterMs=${this.options.slowAckMs}`);
        void this.sendSimple(chatId, slowAckText(senderText))
          .then(() => { if (!state.settled && !state.stopped && showTyping) typing(true); })
          .catch((error) => this.log.warn(`Holding line failed chat=${chatId}: ${error?.message ?? error}`));
      }, this.options.slowAckMs);
      timer.unref?.();
      timers.push(timer);
    }
    const clear = () => { for (const timer of timers) { clearInterval(timer); clearTimeout(timer); } };
    return {
      state,
      settle() {
        if (state.settled || state.stopped) return;
        state.settled = true;
        clear();
      },
      stop() {
        if (state.stopped) return;
        state.stopped = true;
        clear();
        if (showTyping) typing(false);
      },
    };
  }

  /**
   * Wait for the agent's turn and deliver each reply entry once, as soon as it
   * appears (streaming). A reply timeout still delivers what the agent already
   * sent; anything it sends later is picked up by the late-delivery follower.
   */
  async completeTurn(agent, clientNonce, { chatId, quoted, signal, progress } = {}) {
    const turn = newTurnState();
    turn.progress = progress;
    // Recovered turns: quote the original message if it is still cached.
    if (quoted === undefined) quoted = this.quotedForNonce(chatId, clientNonce, agent.id);
    const deliver = (entries) => this.withAgentLock(
      agent.id,
      () => this.deliverEntries(agent, clientNonce, entries, { chatId, quoted, turn }),
    );
    this.beginTurn(agent.id);
    try {
      let reply;
      try {
        reply = await this.grok.waitForReply(agent.id, clientNonce, {
          origin: "whatsapp",
          signal,
          ...(Number.isFinite(this.options.stableReplyMs) ? { stableReplyMs: this.options.stableReplyMs } : {}),
          onApproval: (entry) => this.notifyApproval(chatId, entry, quoted),
          ...(this.mirrorReactionsEnabled(chatId) ? {
            reactionBy: agent.id,
            onPromptEntry: (entry) => this.mirrorAgentReaction(agent, clientNonce, entry, chatId, turn),
          } : {}),
          ...(this.options.streamReplies === false ? {} : {
            onEntries: deliver,
            onEntriesError: (error) => this.log.warn(`Streaming delivery failed chat=${chatId} reason=${error.message}; retrying`),
          }),
        });
      } catch (error) {
        const context = this.state.getPromptContext?.(agent.id, clientNonce);
        if (context?.awaitingCompletion) await this.state.setPromptContext(agent.id, clientNonce, { ...context, awaitingCompletion: false });
        // Live wait over without a final reply: hand the turn to the late poller (bounded by lateMaxAgeMs).
        if (!signal?.aborted && error?.name !== "AbortError") await this.armLateTurn(agent.id, clientNonce, error?.code === "GROK_REPLY_TIMEOUT" ? "timeout" : "error");
        if (error?.code === "GROK_REPLY_TIMEOUT" && !signal?.aborted) {
          if (error.partialEntries?.length) {
            await deliver(error.partialEntries)
              .catch((deliveryError) => this.log.warn(`Delivery after timeout failed chat=${chatId} reason=${deliveryError.message}`));
          }
          const follow = this.options.lateDeliveryWindowMs > 0 ? "; later agent messages will still be forwarded" : "";
          if (turn.handled > 0) {
            this.log.warn(`Turn wait timed out chat=${chatId} delivered=${turn.handled}${follow}`);
            await this.state.retirePromptTurn?.(agent.id, clientNonce, error.partialEntries?.at(-1)?.id ?? clientNonce);
            await this.state.deletePromptContext?.(agent.id, clientNonce);
            return { timedOut: true, delivered: turn.handled };
          }
          this.log.warn(`Turn wait timed out chat=${chatId} delivered=0${follow}`);
          const retried = await this.retryAfterPause(agent, clientNonce, { chatId, quoted, signal, progress });
          if (retried) return retried;
        }
        throw error;
      }
      if (reply.reactionOnly) {
        this.log.info(`Reaction-only reply chat=${chatId} entry=${reply.messageId} (no text posted)`);
        await this.finishLateTurn(agent.id, clientNonce, { chatId, posted: false });
        await this.state.retirePromptTurn?.(agent.id, clientNonce, reply.messageId ?? clientNonce);
        await this.state.deletePromptContext?.(agent.id, clientNonce);
        return { delivered: 0, reactionOnly: true };
      }
      const entries = reply.entries?.length
        ? reply.entries
        : reply.messageId
          ? [{ id: reply.messageId, kind: "send-message", message: { type: "text", content: reply.text ?? "" } }]
          : [];
      await deliver(entries);
      if (reply.backgroundRunning) {
        // Turn ended but a background task is still running: its result may come later.
        await this.armLateTurn(agent.id, clientNonce, "background", { background: true });
        if (turn.sentParts > 0) await this.markAnswered(agent.id, clientNonce, chatId);
      } else {
        await this.finishLateTurn(agent.id, clientNonce, { chatId, posted: turn.sentParts > 0 });
      }
      await this.state.retirePromptTurn?.(agent.id, clientNonce, reply.messageId ?? entries.at(-1)?.id ?? clientNonce);
      await this.state.deletePromptContext?.(agent.id, clientNonce);
      return { delivered: turn.handled };
    } finally {
      this.endTurn(agent.id);
      progress?.stop();
    }
  }

  /**
   * Pause case: the reply wait timed out with nothing delivered and the host was
   * paused during the wait. Send the same prompt once more under a retry nonce;
   * the original turn is retired so a late answer to it is not posted as well.
   */
  async retryAfterPause(agent, clientNonce, { chatId, quoted, signal, progress }) {
    if (!this.options.pauseRetry || /:retry$/.test(clientNonce)) return undefined;
    const saved = this.turnPrompts.get(clientNonce);
    const record = this.state.getLateTurn?.(agent.id, clientNonce);
    const pauseAt = this.transport.lastPauseAt;
    if (!saved || !record || !Number.isFinite(pauseAt) || pauseAt < (record.sentAt ?? Infinity)) return undefined;
    try {
      const entries = await this.transcriptTail(agent.id, { signal });
      const index = entries.findIndex((entry) => isTopLevelPromptEntry(entry) && entry.clientNonce === clientNonce);
      const turnId = index >= 0 ? transcriptTurnId(entries[index].id) : undefined;
      const answered = index >= 0 && entries.slice(index + 1).some((entry) => entry.kind === "send-message"
        && (!turnId || transcriptTurnId(entry.id) === turnId));
      if (answered) return undefined; // the agent did answer; the late follower posts it
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      this.log.warn(`Pause retry check failed chat=${chatId} reason=${error.message}; not retrying`);
      return undefined;
    }
    const retryNonce = `${clientNonce}:retry`;
    this.log.warn(`Pause retry chat=${chatId} msg=${msgIdFromNonce(clientNonce) ?? "?"} agent=${agent.id} pauseAt=${new Date(pauseAt).toISOString()} (timed out after a host pause; sending the prompt once more)`);
    await this.state.deleteLateTurn?.(agent.id, clientNonce);
    await this.state.retirePromptTurn?.(agent.id, clientNonce, clientNonce);
    await this.state.deletePromptContext?.(agent.id, clientNonce);
    const access = this.turnAccess.get(clientNonce);
    if (access) this.rememberTurnAccess(retryNonce, access);
    const quote = this.state.getTurnQuote?.(agent.id, clientNonce);
    if (quote) await this.state.setTurnQuote?.(agent.id, retryNonce, quote, { now: this.options.now() });
    this.turnPrompts.set(retryNonce, saved);
    await this.grok.sendPrompt(agent.id, saved.prompt, retryNonce, { signal, attachmentPaths: saved.attachmentPaths, attachmentNames: saved.attachmentNames });
    const sentAt = this.options.now();
    await this.state.setLateTurn?.(agent.id, retryNonce, { chatId, sentAt, armedAt: sentAt, reason: "pause-retry", access: access ?? "none" });
    await this.state.setPromptContext?.(agent.id, retryNonce, {
      contextKey: retryNonce, clientNonce: retryNonce, origin: "whatsapp", chatId,
      isGroup: chatId.endsWith("@g.us"), replyToMessageId: msgIdFromNonce(clientNonce), createdAt: sentAt, awaitingCompletion: true,
    });
    this.log.info(`Prompt sent chat=${chatId} msg=${msgIdFromNonce(clientNonce) ?? "?"} agent=${agent.id} retry=pause`);
    return this.completeTurn(agent, retryNonce, { chatId, quoted, signal, progress });
  }

  /**
   * Deliver send-message entries to one chat. Each transcript entry has one
   * delivery key per agent, so the live turn, a recovered turn and the late
   * follower can never send the same entry twice. `turn` carries quoting and
   * handoff state across streaming calls.
   */
  async deliverEntries(agent, clientNonce, entries, { chatId, quoted, turn = newTurnState(), late = false, rePrefix }) {
    for (const entry of entries) {
      if (entry?.kind !== "send-message" || turn.stopped) continue;
      if (APPROVAL_ENTRY_TYPES.has(entry.message?.type)) {
        // Live turns announce approvals through onApproval; late ones here.
        if (late && (entry.message.approval?.status === "pending" || entry.message.ask?.status === "pending")) {
          await this.notifyApproval(chatId, entry);
        }
        continue;
      }
      const deliveryKey = `wa:${agent.id}:entry:${entry.id ?? "entry"}`;
      const legacyKey = clientNonce ? `wa:${agent.id}:${clientNonce}:${entry.id ?? "entry"}` : undefined;
      if (legacyKey && this.state.getDeliveryProgress?.(legacyKey)?.completed) continue;
      if (this.state.getDeliveryProgress?.(deliveryKey)?.completed) continue;
      const content = this.grok.getReplyContent([entry]);
      if (content.text === HANDOFF_NOTICE) {
        if (turn.handoffSent) {
          await this.state.completeDeliveryProgress?.(deliveryKey, { nextPart: 0, handoffDuplicate: true });
          continue;
        }
        turn.handoffSent = true;
      }
      const claim = this.state.claimDeliveryProgress
        ? this.state.claimDeliveryProgress(deliveryKey)
        : { progress: { nextPart: 0 }, completed: false };
      if (claim.completed) continue;
      const progress = claim.progress;
      const reactToken = content.attachments?.length ? undefined : parseReactToken(content.text);
      if (reactToken !== undefined) {
        const key = this.mirrorReactionsEnabled(chatId) ? this.reactionKeyFor(chatId, clientNonce, undefined) : undefined;
        await this.state.completeDeliveryProgress?.(deliveryKey, { nextPart: 0, silent: true, reaction: true });
        turn.progress?.settle();
        turn.handled += 1;
        if (key) await this.sendReactionSafe(chatId, key, reactToken, `entry=${entry.id} source=token`);
        else this.log.info(`React token not mirrored chat=${chatId} entry=${entry.id} reason=no-message-key`);
        continue;
      }
      if (isSilentReply(content.text, content.attachments, this.options.silentTokens)) {
        this.log.info(`Silent reply chat=${chatId} entry=${entry.id}${late ? " late=yes" : ""}`);
        await this.state.completeDeliveryProgress?.(deliveryKey, { nextPart: 0, silent: true });
        turn.progress?.settle();
        turn.handled += 1;
        continue;
      }
      let text = content.text ? toWhatsAppText(stripTranscriptPreamble(content.text)) : "";
      const textHash = text ? createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32) : undefined;
      if (late && textHash && (progress.nextPart ?? 0) === 0 && text.replace(/\s+/g, " ").trim().length >= this.options.dupTextMinChars
        && this.state.hasRecentOutbound?.(chatId, textHash, { now: this.options.now(), windowMs: this.options.dupTextWindowMs })) {
        this.log.info(`Late duplicate text skipped chat=${chatId} entry=${entry.id}`);
        await this.state.completeDeliveryProgress?.(deliveryKey, { nextPart: 0, silent: true, duplicateText: true });
        turn.handled += 1;
        continue;
      }
      if (late && rePrefix && !quoted && !turn.quoteUsed && text && (progress.nextPart ?? 0) === 0) text = `${toWhatsAppText(rePrefix)}\n\n${text}`;
      if (this.accessFor(agent.id, clientNonce, chatId) === "faq-only" && containsAccountData(text)) {
        // Code-level backstop: a sender who is not on the group's member list
        // (or not authorised) never gets amounts, facility codes or invoice numbers.
        this.log.warn(`Blocked account data for faq-only sender chat=${chatId} entry=${entry.id}`);
        text = toWhatsAppText(this.router.groupFor?.(chatId)?.faqOnlyBlockedReply ?? FAQ_ONLY_BLOCKED_REPLY);
        content.attachments = [];
      }
      // Smart split (opt-in per group): a few bubbles at natural breaks. The
      // choice is saved with the delivery progress so a restart mid-message
      // resumes on the same split. Only split when the rate budget allows it.
      if (progress.smart === undefined) {
        const splitOptions = this.router.groupFor?.(chatId)?.splitReplies ? this.options.smartSplit : undefined;
        const budget = this.guard.outboundBudget?.(chatId) ?? Infinity;
        const maxParts = splitOptions ? Math.min(splitOptions.maxParts ?? 3, budget - (content.attachments?.length ?? 0) - 1) : 1;
        progress.smart = maxParts > 1 ? maxParts : 0;
      }
      const textChunks = progress.smart ? smartSplit(text, { ...this.options.smartSplit, maxParts: progress.smart }) : splitText(text);
      const parts = [
        ...textChunks.map((chunk) => ({ type: "text", text: chunk })),
        ...(content.attachments ?? []).map((attachment) => ({ type: "file", attachment })),
      ];
      for (let index = progress.nextPart ?? 0; index < parts.length; index += 1) {
        const part = parts[index];
        const pace = progress.smart && part.type === "text" && index > 0;
        if (pace) {
          // Follow-up bubble of a split reply: show "typing…" for a beat, scaled to its length.
          await this.transport.setTyping?.(chatId, true)?.catch?.(() => {});
          await sleep(Math.min(3_000, Math.max(this.options.sendDelayMs, part.text.length * 8)));
        } else if (turn.sentParts > 0 && this.options.sendDelayMs > 0) await sleep(this.options.sendDelayMs);
        let gate = this.guard.takeOutbound(chatId, { windowMs: this.replyWindowMs() });
        // A genuine agent reply that only hit the per-minute rate waits for a free
        // slot (bounded) instead of being dropped for good.
        for (let waited = 0; !gate.ok && /^outbound-(?:chat|global)-rate$/.test(gate.reason) && waited < this.options.rateWaitMaxMs;) {
          const pause = Math.min(Math.max(250, this.guard.outboundWaitMs?.(chatId) ?? 1_000), this.options.rateWaitMaxMs - waited);
          if (waited === 0) this.log.info(`Outbound rate-limited chat=${chatId} entry=${entry.id}; waiting up to ${Math.round(this.options.rateWaitMaxMs / 1000)}s for a slot`);
          await sleep(pause);
          waited += pause;
          gate = this.guard.takeOutbound(chatId, { windowMs: this.replyWindowMs() });
        }
        if (!gate.ok) {
          this.log.warn(`Outbound dropped chat=${chatId} reason=${gate.reason} remainingParts=${parts.length - index}`);
          progress.dropped = gate.reason;
          turn.stopped = true;
          break;
        }
        turn.progress?.settle();
        const sendOptions = !turn.quoteUsed && quoted ? { quoted } : {};
        if (part.type === "text") {
          try {
            await this.transport.sendText(chatId, part.text, sendOptions);
          } catch (error) {
            this.guard.refundOutbound?.(chatId); // nothing was sent: don't burn rate budget on retries
            throw error;
          }
          if (pace) await this.transport.setTyping?.(chatId, false)?.catch?.(() => {});
          this.guard.recordOutboundText(chatId, part.text);
        } else {
          const filename = safeFilename(part.attachment.filename || part.attachment.path?.split("/").at(-1), "grok-file.bin");
          try {
            const bytes = await this.readAttachmentWithRetry(agent.id, part.attachment.path);
            await this.transport.sendFile(chatId, { bytes, filename, mimetype: guessMimeType(filename) }, sendOptions);
          } catch (error) {
            this.log.warn(`Attachment delivery failed chat=${chatId} file=${JSON.stringify(filename)} reason=${error.message}`);
            await this.transport.sendText(chatId, `File wasn't ready to send (${filename}).`, sendOptions);
          }
        }
        turn.quoteUsed = true;
        turn.sentParts += 1;
        progress.nextPart = index + 1;
        await this.state.setDeliveryProgress?.(deliveryKey, progress);
      }
      await this.state.completeDeliveryProgress?.(deliveryKey, progress);
      if (!turn.stopped && textHash) await this.state.recordOutbound?.(chatId, textHash, { now: this.options.now() });
      turn.handled += 1;
      if (!turn.stopped) this.log.info(`Delivered chat=${chatId} entry=${entry.id} parts=${parts.length}${late ? " late=yes" : ""}`);
    }
  }

  // ---- Late delivery: agent messages that arrive after their prompt's turn ----

  /** Live wait ended without a final reply: the late poller may follow this turn for lateMaxAgeMs. */
  async armLateTurn(agentId, clientNonce, reason, extra = {}) {
    if (!this.state.getLateTurn?.(agentId, clientNonce)) return;
    await this.state.setLateTurn(agentId, clientNonce, { armedAt: this.options.now(), reason, ...extra });
  }

  async markAnswered(agentId, clientNonce, chatId) {
    const record = this.state.getLateTurn?.(agentId, clientNonce);
    const sentAt = record?.sentAt ?? this.options.now();
    await this.state.markChatAnswered?.(chatId ?? record?.chatId, sentAt);
    const msgId = this.state.getTurnQuote?.(agentId, clientNonce)?.msgId ?? msgIdFromNonce(clientNonce);
    if (msgId && !/:react$/.test(clientNonce ?? "")) await this.state.markMsgAnswered?.(chatId ?? record?.chatId, msgId, clientNonce, this.options.now());
  }

  /** Final reply handled (posted, silent or reaction): nothing more to poll for this turn. */
  async finishLateTurn(agentId, clientNonce, { chatId, posted }) {
    if (posted) await this.markAnswered(agentId, clientNonce, chatId);
    const record = this.state.getLateTurn?.(agentId, clientNonce);
    const target = chatId ?? record?.chatId;
    if (this.options.followUpWindowMs > 0 && target && clientNonce && this.state.setLateTurn) {
      // Keep watching this conversation for later agent entries (persisted, so a
      // restart resumes the watch; delivery keys prevent any resend).
      const now = this.options.now();
      await this.state.setLateTurn(agentId, clientNonce, {
        chatId: target,
        sentAt: record?.sentAt ?? now,
        armedAt: now,
        reason: "follow-up",
        followUp: true,
        followUntil: now + this.options.followUpWindowMs,
      });
      this.followUpIdle.delete(agentId);
      return;
    }
    await this.state.deleteLateTurn?.(agentId, clientNonce);
  }

  /**
   * Late-delivery guards (rollback/duplicate protection). A late entry is posted
   * only for a turn this bridge sent and still has pending (persisted record), not
   * older than lateMaxAgeMs, and not superseded by a newer answered turn in the
   * same chat (background-task turns are exempt from the ordering rule).
   */
  lateGuard(agentId, target, entry) {
    const record = target?.clientNonce ? this.state.getLateTurn?.(agentId, target.clientNonce) : undefined;
    let reason;
    if (!record && target?.clientNonce && this.unrecordedAfterPause(agentId, target)) {
      return { ok: true, adopt: true };
    }
    if (!record) reason = target?.clientNonce ? "prompt-not-pending" : "unknown-prompt";
    else if (record.followUp ? this.options.now() > (record.followUntil ?? 0) : this.options.now() - (record.armedAt ?? record.sentAt ?? 0) > this.options.lateMaxAgeMs) reason = "too-old";
    else {
      // Clearly superseded only: the same question was answered later by ANOTHER
      // turn (e.g. a retry). A newer answer to a different message is fine; the
      // late post then quotes its own question.
      const msgId = this.state.getTurnQuote?.(agentId, target.clientNonce)?.msgId ?? msgIdFromNonce(target.clientNonce);
      const answered = this.state.getMsgAnswered?.(target.chatId, msgId);
      if (answered && answered.nonce !== target.clientNonce && answered.at > (record.sentAt ?? 0)) reason = "superseded";
    }
    if (!reason) return { ok: true, record };
    this.metrics.lateSkipped += 1;
    this.log.warn(`Late message skipped agent=${agentId} chat=${target?.chatId} entry=${entry?.id} reason=${reason}`);
    return { ok: false, reason };
  }

  /**
   * A WhatsApp prompt this bridge sent but has no record of: the host was paused
   * (or rolled back) right after sending it, so its state writes were lost. Its
   * replies are adopted when the prompt is recent, falls inside the pause, and no
   * other turn of this bridge handled the same message (that one owns the answer).
   */
  unrecordedAfterPause(agentId, target) {
    const at = target.promptAt;
    const pauseAt = this.transport.lastPauseAt;
    const pauseMs = this.transport.lastPauseMs ?? 0;
    if (!Number.isFinite(at) || !Number.isFinite(pauseAt)) return false;
    if (this.options.now() - at > this.options.lateMaxAgeMs) return false;
    if (at < pauseAt - pauseMs - 5 * 60_000 || at > pauseAt + 60_000) return false;
    const msgId = msgIdFromNonce(target.clientNonce);
    if (!msgId || chatFromNonce(target.clientNonce) !== target.chatId) return false;
    const others = this.state.turnNoncesForMsg?.(agentId, target.chatId, msgId) ?? [];
    if (others.some((nonce) => nonce !== target.clientNonce)) return false;
    if (this.state.getMsgAnswered?.(target.chatId, msgId)) return false;
    return true;
  }

  /** Is this chat, in the CURRENT config, routed to this agent? */
  chatServesAgent(chatId, agentId, agents = [], served) {
    let wanted = this.router.agentForChat?.(chatId);
    if (!wanted && served?.chatId === chatId && served.dmId) wanted = this.router.agentForChat?.(served.dmId);
    if (!wanted) return false;
    return wanted === agentId || this.resolveAgent(wanted, agents)?.id === agentId;
  }

  /** Newest open (pending or follow-up) watch of an agent, preferring the given chat. */
  openWatchFor(agentId, chatHint) {
    const now = this.options.now();
    const open = (this.state.listLateTurns?.() ?? []).filter((record) => record.agentId === agentId
      && (record.followUp ? now <= (record.followUntil ?? 0) : now - (record.armedAt ?? record.sentAt ?? 0) <= this.options.lateMaxAgeMs));
    const pool = open.some((record) => record.chatId === chatHint) ? open.filter((record) => record.chatId === chatHint) : open;
    if (!pool.length || new Set(pool.map((record) => record.chatId)).size > 1) return undefined; // ambiguous: don't guess
    return pool.reduce((a, b) => ((b.sentAt ?? 0) > (a.sentAt ?? 0) ? b : a));
  }

  /** Which chat, if any, a late send-message entry belongs to. */
  lateTarget(agentId, owner, served, agents, entry) {
    const now = this.options.now();
    const windowMs = this.options.lateDeliveryWindowMs;
    if (Number.isFinite(entry?.timestampMs) && now - entry.timestampMs > windowMs) return undefined;
    if (owner?.kind === "other") return undefined; // desktop / Telegram / other client turn: not ours
    const chatId = owner?.kind === "whatsapp" ? owner.chatId : served?.chatId;
    if (!chatId) return undefined;
    if (!this.chatServesAgent(chatId, agentId, agents, served)) {
      this.log.warn(`Late message not delivered agent=${agentId} chat=${chatId} entry=${entry?.id} reason=chat-not-configured-for-agent`);
      return undefined;
    }
    const servedAt = Math.max(
      owner?.kind === "whatsapp" && Number.isFinite(owner.at) ? owner.at : 0,
      served?.chatId === chatId && Number.isFinite(served.at) ? served.at : 0,
    );
    if (!servedAt || now - servedAt > windowMs) return undefined;
    // The window is measured from that chat's own prompt (an accepted inbound message).
    this.guard.openReplyWindow(chatId, Math.min(servedAt, now));
    return {
      chatId,
      clientNonce: owner?.kind === "whatsapp" ? owner.clientNonce : undefined,
      ...(owner?.kind === "whatsapp" ? { promptAt: owner.at, promptAccess: owner.access } : {}),
    };
  }

  promptOwner(entry) {
    const chatId = chatFromNonce(entry?.clientNonce);
    if (chatId) {
      // Access as written by this bridge in the trusted [whatsapp-role] header (user copies are stripped).
      const access = /^\[whatsapp-role\][^\n]*\baccess=(full|account|faq-only)\b/m.exec(typeof entry.content === "string" ? entry.content : "")?.[1];
      return { kind: "whatsapp", chatId, clientNonce: entry.clientNonce, promptId: entry.id, at: Number.isFinite(entry.timestampMs) ? entry.timestampMs : undefined, ...(access ? { access } : {}) };
    }
    // No client nonce at all: a system/background wake, not another client's user.
    return typeof entry?.clientNonce === "string" && entry.clientNonce ? { kind: "other" } : { kind: "wake", promptId: entry?.id };
  }

  async transcriptTail(agentId, options = {}) {
    try {
      return await this.grok.getTranscriptTail(agentId, 200, options);
    } catch (error) {
      if (!/HTTP 404$/.test(error.message)) throw error;
      return this.grok.getTranscript(agentId, options);
    }
  }

  /** One pass for one agent: deliver unseen send-message entries past the cursor. */
  async followAgent(agentId, served, agents, options = {}) {
    let entries = await this.transcriptTail(agentId, options);
    if (!entries.length) return;
    const cursor = this.state.getMirrorCursor?.(agentId);
    // Oldest still-pending turn of this agent whose prompt is in view. Everything
    // before it belongs to finished turns, which the poller never posts.
    const pendingNonces = new Set((this.state.listLateTurns?.() ?? []).filter((turn) => turn.agentId === agentId).map((turn) => turn.clientNonce));
    const pendingPromptIndex = entries.findIndex((entry) => isTopLevelPromptEntry(entry) && pendingNonces.has(entry.clientNonce));
    let cursorIndex;
    if (!cursor && pendingPromptIndex >= 0) {
      cursorIndex = pendingPromptIndex - 1;
    } else if (!cursor) {
      // First pass for this agent: start just before its latest recent WhatsApp
      // prompt (so nothing from that turn is lost), else at the newest entry.
      const now = this.options.now();
      let promptIndex = -1;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!isTopLevelPromptEntry(entry)) continue;
        if (chatFromNonce(entry.clientNonce)
          && (!Number.isFinite(entry.timestampMs) || now - entry.timestampMs <= this.options.lateDeliveryWindowMs)) promptIndex = index;
        break;
      }
      if (promptIndex < 0) {
        await this.state.setMirrorCursor(agentId, entries.at(-1)?.id ?? null);
        return;
      }
      cursorIndex = promptIndex - 1;
      await this.state.setMirrorCursor(agentId, cursorIndex >= 0 ? entries[cursorIndex].id : null);
    } else if (cursor.entryId === null) {
      cursorIndex = -1;
    } else {
      cursorIndex = entries.findIndex((entry) => entry?.id === cursor.entryId);
      let resumedAtPending = false;
      if (cursorIndex < 0 && pendingPromptIndex >= 0) {
        // Old cursor (agent not followed for a while): no full-transcript fetch needed.
        cursorIndex = pendingPromptIndex - 1;
        resumedAtPending = true;
      }
      if (cursorIndex < 0 && !resumedAtPending) {
        entries = await this.grok.getTranscript(agentId, options);
        cursorIndex = entries.findIndex((entry) => entry?.id === cursor.entryId);
        if (cursorIndex < 0) {
          this.log.warn(`Late delivery cursor not found agent=${agentId}; restarting from the newest entry`);
          await this.state.setMirrorCursor(agentId, entries.at(-1)?.id ?? null);
          return;
        }
      }
    }
    if (pendingPromptIndex > cursorIndex + 1) cursorIndex = pendingPromptIndex - 1;
    let owner;
    for (let index = cursorIndex; index >= 0; index -= 1) {
      if (isTopLevelPromptEntry(entries[index])) {
        owner = this.promptOwner(entries[index]);
        break;
      }
    }
    // Transcript ids carry their turn ("t310s655" -> "t310"). A reply can land in
    // the tail after a newer turn's prompt (late/retried delivery), so map each
    // reply to the prompt of its own turn, not merely the latest prompt seen.
    const promptByTurn = new Map();
    for (const entry of entries) {
      const turnId = transcriptTurnId(entry?.id);
      if (turnId && isTopLevelPromptEntry(entry) && !promptByTurn.has(turnId)) promptByTurn.set(turnId, this.promptOwner(entry));
    }
    const minTurn = (() => {
      for (const entry of entries) { const id = transcriptTurnId(entry?.id); if (id) return Number(id.slice(1)); }
      return undefined;
    })();
    const turns = new Map();
    const answeredThisPass = new Map();
    for (let index = cursorIndex + 1; index < entries.length; index += 1) {
      const entry = entries[index];
      if (typeof entry?.id !== "string" || !entry.id) break; // no cursor to advance to
      if (isTopLevelPromptEntry(entry)) {
        owner = this.promptOwner(entry);
      } else if (entry.kind === "send-message") {
        let entryOwner = owner;
        let quoteKnown = true;
        if (chatFromNonce(entry.clientNonce)) {
          entryOwner = this.promptOwner(entry);
        } else {
          const turnId = transcriptTurnId(entry.id);
          const turnPrompt = turnId ? promptByTurn.get(turnId) : undefined;
          // Turn started by a wake (no prompt entry in view although the turn is
          // newer than the oldest entry we see, or a prompt without any client
          // nonce): link it to the agent's open follow-up watch for this chat.
          // Never link when the latest prompt before it came from another client (desktop user).
          const wakeTurn = turnId && owner?.kind !== "other" && (turnPrompt?.kind === "wake"
            || (!turnPrompt && Number.isFinite(minTurn) && Number(turnId.slice(1)) > minTurn));
          const watch = wakeTurn ? this.openWatchFor(agentId, served?.chatId ?? owner?.chatId) : undefined;
          if (watch) {
            entryOwner = { kind: "whatsapp", chatId: watch.chatId, clientNonce: watch.clientNonce, at: watch.sentAt };
            this.log.info(`Late wake entry linked agent=${agentId} entry=${entry.id} chat=${watch.chatId} msg=${msgIdFromNonce(watch.clientNonce) ?? "?"}`);
          } else if (turnPrompt) entryOwner = turnPrompt;
          else if (turnId && owner?.clientNonce && transcriptTurnId(owner.promptId) && transcriptTurnId(owner.promptId) !== turnId) {
            quoteKnown = false; // own prompt not in view: same chat, but no quote
          }
        }
        let target = this.lateTarget(agentId, entryOwner, served, agents, entry);
        if (target && !quoteKnown) target.clientNonce = undefined;
        if (target && !(target.clientNonce && answeredThisPass.has(target.clientNonce))) {
          const verdict = this.lateGuard(agentId, target, entry);
          if (!verdict.ok) target = undefined;
          else if (verdict.adopt) {
            const now = this.options.now();
            this.log.warn(`Late message adopted agent=${agentId} chat=${target.chatId} entry=${entry.id} msg=${msgIdFromNonce(target.clientNonce)} reason=prompt-unrecorded-after-pause`);
            await this.state.setLateTurn?.(agentId, target.clientNonce, {
              chatId: target.chatId, sentAt: target.promptAt, armedAt: now, reason: "adopted-after-pause",
              access: target.promptAccess ?? (this.router.groupFor?.(target.chatId)?.members ? "faq-only" : "none"),
            });
          }
        }
        if (target) {
          const turnKey = `${target.chatId}|${target.clientNonce ?? ""}`;
          if (!turns.has(turnKey)) turns.set(turnKey, newTurnState());
          const handledBefore = turns.get(turnKey).handled;
          const lateQuote = this.lateQuote(target.chatId, target.clientNonce, agentId);
          await this.deliverEntries({ id: agentId }, target.clientNonce, [entry], {
            chatId: target.chatId,
            quoted: lateQuote.quoted,
            rePrefix: lateQuote.rePrefix,
            turn: turns.get(turnKey),
            late: true,
          });
          // Entries already delivered earlier (delivery key done) neither finish nor extend a watch.
          const newlyHandled = turns.get(turnKey).handled > handledBefore;
          if (newlyHandled && !answeredThisPass.has(target.clientNonce)) answeredThisPass.set(target.clientNonce, { chatId: target.chatId, turn: turns.get(turnKey) });
        }
      }
      await this.state.setMirrorCursor(agentId, entry.id);
    }
    // The late reply arrived: this turn is answered, stop following it.
    for (const [clientNonce, { chatId, turn }] of answeredThisPass) {
      await this.finishLateTurn(agentId, clientNonce, { chatId, posted: turn.sentParts > 0 });
    }
    return answeredThisPass.size;
  }

  /** Transient gateway trouble (warm-up after a pause): back off, don't hammer. */
  static isTransientGatewayError(error) {
    return /HTTP 5\d\d|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/i.test(`${error?.name ?? ""} ${error?.message ?? ""}`);
  }

  latePollDelayMs(failures) {
    const base = Math.max(1, this.options.lateDeliveryPollMs);
    const capped = Math.min(this.options.latePollMaxBackoffMs, base * (2 ** Math.min(failures, 20)));
    return Math.round(capped * (0.5 + Math.random() * 0.5)); // jitter
  }

  /**
   * Poll only agents that have a turn pending delivery (prompt sent, final reply
   * not posted, live wait over). Turns older than lateMaxAgeMs are given up.
   */
  async pollLateOnce(options = {}) {
    const windowMs = this.options.lateDeliveryWindowMs;
    if (!(windowMs > 0)) return;
    const now = this.options.now();
    const byAgent = new Map();
    const followOnly = new Map(); // agentId -> true while it has only follow-up watches
    for (const record of this.state.listLateTurns?.() ?? []) {
      const age = now - (record.armedAt ?? record.sentAt ?? 0);
      if (record.followUp) {
        if (now > (record.followUntil ?? 0)) {
          this.log.info(`Follow-up window closed agent=${record.agentId} chat=${record.chatId} msg=${msgIdFromNonce(record.clientNonce) ?? "?"}`);
          await this.state.deleteLateTurn(record.agentId, record.clientNonce);
          continue;
        }
        if (!byAgent.has(record.agentId)) { byAgent.set(record.agentId, record); followOnly.set(record.agentId, true); }
        continue;
      }
      if (age > this.options.lateMaxAgeMs || now - (record.sentAt ?? 0) > windowMs) {
        this.metrics.lateExpired += 1;
        this.log.warn(`Late reply gave up agent=${record.agentId} chat=${record.chatId} msg=${msgIdFromNonce(record.clientNonce) ?? "?"} reason=expired armed=${record.reason ?? "?"} ageMs=${age}`);
        await this.state.deleteLateTurn(record.agentId, record.clientNonce);
        continue;
      }
      if (!byAgent.has(record.agentId) || followOnly.get(record.agentId)) byAgent.set(record.agentId, record);
      followOnly.set(record.agentId, false);
    }
    for (const backoffAgent of this.latePollBackoff.keys()) if (!byAgent.has(backoffAgent)) this.latePollBackoff.delete(backoffAgent);
    for (const idleAgent of this.followUpIdle.keys()) if (!followOnly.get(idleAgent)) this.followUpIdle.delete(idleAgent);
    let agents;
    for (const [agentId, record] of byAgent) {
      // A live turn (or recovery) is streaming this agent's replies itself.
      if (this.activeTurns.has(agentId) || this.pendingRecovery.has(agentId)) continue;
      const backoff = this.latePollBackoff.get(agentId);
      if (backoff && now < backoff.nextAt) continue;
      const idle = followOnly.get(agentId) ? this.followUpIdle.get(agentId) : undefined;
      if (idle && now < idle.nextAt) continue;
      const served = this.state.getLastServed?.(agentId) ?? { chatId: record.chatId, at: record.sentAt };
      try {
        agents ??= await this.grok.listAgents(options);
        this.metrics.latePolls += 1;
        const delivered = await this.withAgentLock(agentId, () => (this.activeTurns.has(agentId)
          ? undefined
          : this.followAgent(agentId, served, agents, options)));
        this.latePollBackoff.delete(agentId);
        if (followOnly.get(agentId) && !delivered) {
          const idleCount = (idle?.idle ?? 0) + 1;
          const base = Math.max(1, this.options.lateDeliveryPollMs);
          this.followUpIdle.set(agentId, { idle: idleCount, nextAt: now + Math.min(this.options.followUpPollMaxMs, base * (2 ** Math.min(idleCount, 20))) });
        } else {
          this.followUpIdle.delete(agentId);
        }
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") throw error;
        this.metrics.latePollErrors += 1;
        const failures = (backoff?.failures ?? 0) + 1;
        const transient = WhatsAppBridge.isTransientGatewayError(error);
        const delay = this.latePollDelayMs(transient ? failures : Math.max(failures, 3));
        this.latePollBackoff.set(agentId, { failures, nextAt: now + delay });
        this.log.warn(`Late delivery failed agent=${agentId} reason=${error.message}; retry in ${delay}ms (failures=${failures})`);
        if (!agents) break; // listAgents itself failed: same gateway, try again next tick
      }
    }
  }

  /**
   * Replay inbound messages left in the journal by a crash or SIGTERM. Called once
   * after the first connect. Too-old entries are dropped (logged).
   */
  async replayJournal(options = {}) {
    if (!this.journal?.size) return 0;
    const maxAgeMs = Math.max((this.options.catchUpMaxAgeMs || 0), this.options.maxMessageAgeSec * 1000);
    const now = this.options.now();
    const tasks = [];
    for (const { key, event, at } of this.journal.list()) {
      const tsMs = Number.isFinite(event?.timestamp) ? event.timestamp * 1000 : at;
      if (!event?.id || now - tsMs > maxAgeMs) {
        this.log.warn(`Journal entry dropped (too old) chat=${event?.chatId ?? "?"} msg=${event?.id ?? "?"} ageMs=${now - tsMs}`);
        this.journal.remove(key);
        continue;
      }
      this.metrics.journalReplayed += 1;
      this.log.info(`Replaying journaled inbound chat=${event.chatId} msg=${event.id}`);
      tasks.push(Promise.resolve(this.ingest({ ...event, catchUp: true, replayed: true, receivedAt: at }, options)).catch(() => {}));
    }
    await Promise.allSettled(tasks);
    return tasks.length;
  }

  /** Background loop for late delivery. Resolves when the signal aborts. */
  async runLateDelivery(options = {}) {
    if (!(this.options.lateDeliveryWindowMs > 0)) return;
    let failures = 0;
    while (!options.signal?.aborted) {
      try {
        await this.pollLateOnce(options);
        failures = 0;
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") break;
        failures += 1;
        this.log.warn(`Late delivery poll failed reason=${error.message}`);
      }
      const delay = failures ? Math.min(this.options.lateDeliveryPollMs * (2 ** failures), 60_000) : this.options.lateDeliveryPollMs;
      try {
        await sleep(delay, undefined, { signal: options.signal });
      } catch {
        break;
      }
    }
  }

  async readAttachmentWithRetry(agentId, attachmentPath) {
    let lastError;
    for (let attempt = 1; attempt <= ATTACHMENT_READ_ATTEMPTS; attempt += 1) {
      try {
        return await this.grok.readAttachment(agentId, attachmentPath);
      } catch (error) {
        lastError = error;
        if (/exceeds 20 MB|empty or exceeds|unsupported data attachment|invalid file attachment URL/i.test(error.message)) break;
        if (attempt < ATTACHMENT_READ_ATTEMPTS) await sleep(this.options.attachmentReadBackoffMs(attempt - 1));
      }
    }
    throw lastError;
  }

  /** Reply-only, rate-limited plain send used for help/status/notices. */
  async sendSimple(chatId, text, quoted) {
    const gate = this.guard.takeOutbound(chatId);
    if (!gate.ok) {
      this.log.warn(`Outbound dropped chat=${chatId} reason=${gate.reason}`);
      return false;
    }
    await this.transport.sendText(chatId, toWhatsAppText(text), quoted ? { quoted } : {});
    this.guard.recordOutboundText(chatId, text);
    return true;
  }

  async notifyApproval(chatId, entry, quoted) {
    if (!entry?.id || this.notifiedApprovals.has(entry.id)) return;
    this.notifiedApprovals.add(entry.id);
    if (this.notifiedApprovals.size > 500) this.notifiedApprovals.delete(this.notifiedApprovals.values().next().value);
    this.log.info(`Approval handed to desktop chat=${chatId} entry=${entry.id}`);
    await this.sendSimple(chatId, APPROVAL_NOTICE, quoted).catch((error) => this.log.warn(`Approval notice failed: ${error.message}`));
  }

  async handleError(input, error, _options = {}) {
    const unit = Array.isArray(input?.batch) && input.batch.length ? input.batch.at(-1) : input;
    const primary = Array.isArray(unit?.bundled) && unit.bundled.length ? unit.bundled[0] : unit;
    const route = this.router.route(primary);
    if (!route.ok || !this.guard.hasReplyWindow(primary.chatId)) return;
    this.log.warn(`Turn failed chat=${primary.chatId} msg=${primary.id} reason=${error?.message ?? "unknown"}`);
    await this.sendSimple(primary.chatId, ERROR_NOTICE, this.quotedFor(route, primary))
      .catch((sendError) => this.log.error(`Error notice failed: ${sendError.message}`));
  }

  /**
   * After a restart, finish WhatsApp turns that were still waiting on the agent
   * (the reply goes back to the same chat, without a quote). Old ones are dropped.
   */
  async recoverPending(options = {}) {
    const agentIds = this.state.listPromptContextAgentIds?.() ?? [];
    // Same age limit as before: an old turn's first messages would arrive out of
    // order and stale. Anything the agent sends later is the late follower's job.
    const maxAgeMs = this.options.replyTimeoutMs * 2;
    const tasks = [];
    for (const agentId of agentIds) {
      const agentTasks = [];
      for (const context of this.state.listPromptContexts(agentId)) {
        if (context.origin !== "whatsapp" || !context.chatId) continue;
        const nonce = context.clientNonce ?? context.contextKey;
        const age = this.options.now() - (context.createdAt ?? 0);
        if (age > maxAgeMs) {
          this.log.warn(`Dropping stale pending turn chat=${context.chatId} ageMs=${age}`);
          await this.state.deletePromptContext(agentId, nonce);
          continue;
        }
        this.guard.openReplyWindow(context.chatId, context.createdAt);
        if (Number.isFinite(context.createdAt)) {
          await this.state.setLastServed?.(agentId, { chatId: context.chatId, at: context.createdAt });
        }
        this.log.info(`Recovering pending turn chat=${context.chatId} agent=${agentId}`);
        // Same hold cap as a live turn: after turnQueueHoldMs the queue (and
        // pendingRecovery) is released and the recovered reply keeps delivering
        // in the background, so new messages are not stuck behind it.
        const recoveryFailed = (error) => {
          if (options.signal?.aborted || error?.name === "AbortError") return;
          this.log.warn(`Recovery failed chat=${context.chatId} reason=${error?.message ?? error}`);
        };
        agentTasks.push(this.dispatcher.enqueue(`agent:${agentId}`, () => this.holdQueue(this.completeTurn({ id: agentId }, nonce, {
          chatId: context.chatId,
          signal: options.signal,
        }), { chatId: context.chatId, msgId: `recovered:${nonce}`, onLateError: recoveryFailed }).catch(recoveryFailed)));
      }
      if (!agentTasks.length) continue;
      // Keep the late follower off this agent until its recovered turns finish (keeps order).
      const done = Promise.allSettled(agentTasks).then(() => {
        if (this.pendingRecovery.get(agentId) === done) this.pendingRecovery.delete(agentId);
      });
      this.pendingRecovery.set(agentId, done);
      tasks.push(...agentTasks);
    }
    return Promise.allSettled(tasks);
  }

  /**
   * Proactive post without a human message (scripts/nudge.mjs -> state/nudges/).
   * Only for groups with "allowNudge": true. Sends the routed agent a synthetic
   * scheduled-check prompt; its reply goes out through the normal reply path
   * (rate limits, silent token, Bot_Log by the agent). At most one per group
   * per `scheduledCheckCooldownMs`.
   */
  async runScheduledCheck(chatId, { source = "local-cli", id = String(this.options.now()), signal, adminPrompt } = {}) {
    const group = this.router.groupFor?.(chatId);
    if (!group) return { dropped: "group-not-configured" };
    const admin = typeof adminPrompt === "string" && adminPrompt.trim() ? adminPrompt.trim().slice(0, 2000) : undefined;
    // Admin prompts (scripts/admin-prompt.mjs, box-only) work in any configured group.
    if (!admin && !group.allowNudge) return { dropped: "nudge-not-allowed" };
    const cooldown = this.options.scheduledCheckCooldownMs ?? 120_000;
    const last = this.lastScheduledCheck.get(group.jid) ?? 0;
    if (this.options.now() - last < cooldown) return { dropped: "cooldown" };
    this.lastScheduledCheck.set(group.jid, this.options.now());
    const agents = await this.grok.listAgents({ signal });
    const agent = this.resolveAgent(group.agent, agents);
    if (!agent) {
      this.log.error(`Scheduled check: agent not found chat=${group.jid} agent=${JSON.stringify(group.agent)}`);
      return { dropped: "agent-not-found" };
    }
    const safeId = String(id).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "x";
    const clientNonce = `whatsapp:${group.jid}:nudge-${admin ? "admin-" : ""}${safeId}`;
    if (this.state.isPromptTurnRetired?.(agent.id, clientNonce) || this.state.getPromptContext?.(agent.id, clientNonce)) {
      return { dropped: "duplicate" };
    }
    const header = buildContextHeader({
      sender: { name: admin ? "group admin (via the box)" : "scheduled check" },
      chat: { jid: group.jid, type: "group", name: this.transport.chatName?.(group.jid) ?? group.name },
      member: { role: "system", authorised: true, access: "full", name: admin ? "admin prompt" : "bridge scheduler" },
      trigger: { kind: admin ? "admin-prompt" : "scheduled-check", source: source === "bdm" ? "bdm" : "local-cli" },
    });
    return this.dispatcher.enqueue(`agent:${agent.id}`, async () => {
      // A deliberate, operator-triggered exception to reply-only: open this group's window now.
      this.guard.openReplyWindow(group.jid);
      this.beginTurn(agent.id);
      try {
        await this.grok.sendPrompt(agent.id, `${header}\n\n${admin ?? SCHEDULED_CHECK_PROMPT}`, clientNonce, { signal });
        await this.state.setPromptContext(agent.id, clientNonce, {
          contextKey: clientNonce, clientNonce, origin: "whatsapp", chatId: group.jid, isGroup: true,
          createdAt: this.options.now(), awaitingCompletion: true,
        });
        await this.state.setLastServed?.(agent.id, { chatId: group.jid, at: this.options.now() });
        this.log.info(`${admin ? "Admin prompt" : "Scheduled check"} sent chat=${group.jid} agent=${agent.id} source=${source} id=${safeId}`);
        await this.completeTurn(agent, clientNonce, { chatId: group.jid, signal });
        return { handled: admin ? "admin-prompt" : "scheduled-check", clientNonce, agentId: agent.id };
      } finally {
        this.endTurn(agent.id);
      }
    });
  }

  /**
   * Transport callback for group-participants.update action=add (admin add or invite-link join).
   * Opt-in per group (greetNewMembers). Never greets the bot itself; bulk adds within
   * greetDebounceMs become ONE greeting turn.
   */
  onMembersJoined({ chatId, action = "add", participants = [] } = {}, options = {}) {
    if (action !== "add") return { dropped: "not-add" };
    const group = this.router.groupFor?.(chatId);
    if (!group) return { dropped: "group-not-configured" };
    if (!group.greetNewMembers) return { dropped: "greeting-off" };
    const self = new Set(this.selfIds().flatMap((id) => [bareJid(id), String(bareJid(id) ?? "").split("@")[0]]).filter(Boolean));
    const isSelf = (person) => [person.jid, person.pn, person.lid].filter(Boolean)
      .some((id) => self.has(bareJid(id)) || self.has(String(bareJid(id)).split("@")[0]));
    const now = this.options.now();
    let pending = this.pendingGreetings.get(group.jid);
    let added = 0;
    for (const person of participants) {
      if (!person?.jid || isSelf(person)) continue;
      const key = `${group.jid}|${person.lid ?? person.pn ?? person.jid}`;
      if (now - (this.greeted.get(key) ?? -Infinity) < this.options.greetRepeatMs) continue;
      if (!pending) {
        pending = { members: new Map(), timer: undefined };
        this.pendingGreetings.set(group.jid, pending);
      }
      pending.members.set(key, person);
      added += 1;
    }
    if (!added) return { dropped: "no-new-members" };
    this.log.info(`Member join queued for greeting chat=${group.jid} new=${added} pending=${pending.members.size}`);
    clearTimeout(pending.timer);
    pending.promise ??= new Promise((resolve) => { pending.resolve = resolve; });
    pending.timer = setTimeout(() => {
      this.pendingGreetings.delete(group.jid);
      const result = this.runMemberGreeting(group, [...pending.members.entries()], options)
        .catch((error) => { this.log.error(`Member greeting failed chat=${group.jid}: ${error?.message ?? error}`); return { dropped: "error" }; });
      pending.resolve(result);
    }, Math.max(0, this.options.greetDebounceMs));
    pending.timer.unref?.();
    return { queued: added, done: pending.promise };
  }

  async runMemberGreeting(group, entries, { signal } = {}) {
    const agents = await this.grok.listAgents({ signal });
    const agent = this.resolveAgent(group.agent, agents);
    if (!agent) {
      this.log.error(`Member greeting: agent not found chat=${group.jid} agent=${JSON.stringify(group.agent)}`);
      return { dropped: "agent-not-found" };
    }
    const now = this.options.now();
    for (const [key] of entries) this.greeted.set(key, now);
    if (this.greeted.size > 2000) this.greeted.delete(this.greeted.keys().next().value);
    const members = entries.map(([, person]) => person);
    const clientNonce = `whatsapp:${group.jid}:join-${now}`;
    const header = buildContextHeader({
      sender: { name: "group event" },
      chat: { jid: group.jid, type: "group", name: this.transport.chatName?.(group.jid) ?? group.name },
      trigger: { kind: "member-joined", source: "bridge", count: members.length, members },
    });
    return this.dispatcher.enqueue(`agent:${agent.id}`, async () => {
      // Deliberate exception to reply-only, like the scheduled check: open this group's window.
      this.guard.openReplyWindow(group.jid);
      this.beginTurn(agent.id);
      try {
        await this.grok.sendPrompt(agent.id, `${header}\n\n${MEMBER_JOINED_PROMPT}`, clientNonce, { signal });
        await this.state.setPromptContext(agent.id, clientNonce, {
          contextKey: clientNonce, clientNonce, origin: "whatsapp", chatId: group.jid, isGroup: true,
          createdAt: now, awaitingCompletion: true,
        });
        await this.state.setLastServed?.(agent.id, { chatId: group.jid, at: now });
        this.log.info(`Member greeting sent chat=${group.jid} agent=${agent.id} members=${members.length}`);
        await this.completeTurn(agent, clientNonce, { chatId: group.jid, signal });
        return { handled: "member-joined", clientNonce, agentId: agent.id, members: members.length };
      } finally {
        this.endTurn(agent.id);
      }
    });
  }

  drain() {
    return this.dispatcher.drain();
  }
}
