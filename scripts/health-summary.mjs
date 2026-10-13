#!/usr/bin/env node
/**
 * Compact bridge health summary for the keep-alive routine (read-only, no secrets).
 *   node scripts/health-summary.mjs            -> new log lines since the last run (offset file)
 *   node scripts/health-summary.mjs --daily    -> last 24h pause/reconnect summary (no offset change)
 *   --no-advance  report new lines without moving the offset
 * Env: BRIDGE_HOME (default: repo root), WA_BRIDGE_LOG, WA_BRIDGE_STATUS, WA_HEALTH_OFFSET.
 * Times are shown in Asia/Kuala_Lumpur (UTC+8).
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const home = process.env.BRIDGE_HOME ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logFile = process.env.WA_BRIDGE_LOG ?? path.join(home, "bridge.log");
const statusFile = process.env.WA_BRIDGE_STATUS ?? path.join(home, "state", "status.json");
const offsetFile = process.env.WA_HEALTH_OFFSET ?? path.join(home, "state", "health-summary.offset");
const nowMs = Number(process.env.WA_HEALTH_NOW_MS) || Date.now();
const DAILY_MAX_BYTES = 8 * 1024 * 1024;

const kl = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
const ago = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? `${Math.round((nowMs - t) / 1000)}s` : "?"; };

function readRange(file, start) {
  const fd = openSync(file, "r");
  try {
    const { size, ino } = fstatSync(fd);
    const from = Math.min(Math.max(0, start), size);
    const buffer = Buffer.alloc(size - from);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, from + read);
      if (!n) break;
      read += n;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), size, ino, from };
  } finally {
    closeSync(fd);
  }
}

function loadOffset() {
  try { return JSON.parse(readFileSync(offsetFile, "utf8")); } catch { return undefined; }
}

function saveOffset(value) {
  const tmp = `${offsetFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, offsetFile);
}

function lineTime(line) {
  const t = Date.parse(line.slice(0, 24));
  return Number.isFinite(t) ? t : undefined;
}

function count(lines) {
  const c = {
    pauses: 0, pauseSec: [], connected: 0, connectDownMs: [], disconnects: 0, fullChecks: 0, lightChecks: 0, missingGroups: 0,
    drops: {}, outboundDropped: 0, lateFailed: 0, late500: 0, lateTimeouts: 0, lateDelivered: 0, lateSkipped: 0,
    lostReplies: 0, bgWindowsClosed: 0, turnFailed: 0, timeoutNoReply: 0, errors: 0, alerts: 0, restarts: 0,
    promptsReused: 0, journalReplayed: 0, journalDropped: 0, ensureTimeouts: 0, first: undefined, last: undefined,
    pauseTimes: [], resumeLatencyS: [],
  };
  let lastPauseAt;
  for (const line of lines) {
    const t = lineTime(line);
    if (t === undefined) continue;
    c.first ??= t;
    c.last = t;
    let m;
    if ((m = /Box was paused for about (\d+)s/.exec(line))) { c.pauses += 1; c.pauseSec.push(Number(m[1])); c.pauseTimes.push(t); lastPauseAt = t; }
    else if (/WhatsApp connected/.test(line)) {
      c.connected += 1;
      if ((m = /downMs=(\d+)/.exec(line))) c.connectDownMs.push(Number(m[1]));
      if (lastPauseAt !== undefined) { c.resumeLatencyS.push((t - lastPauseAt) / 1000); lastPauseAt = undefined; }
    }
    else if (/WhatsApp disconnected code=/.test(line)) c.disconnects += 1;
    else if ((m = /Group check configured=\d+ visible=\d+ missing=(\d+)/.exec(line))) { c.fullChecks += 1; if (Number(m[1])) c.missingGroups = Number(m[1]); }
    else if (/Group check skipped/.test(line)) c.lightChecks += 1;
    else if ((m = /Drop (?:inbound|group message|turn) reason=([\w:-]+)/.exec(line))) c.drops[m[1]] = (c.drops[m[1]] ?? 0) + 1;
    else if (/Outbound dropped/.test(line)) c.outboundDropped += 1;
    else if (/Late delivery (?:poll )?failed/.test(line)) { c.lateFailed += 1; if (/HTTP 5\d\d/.test(line)) c.late500 += 1; if (/timeout/i.test(line)) c.lateTimeouts += 1; }
    else if (/Delivered .* late=yes/.test(line)) c.lateDelivered += 1;
    else if (/Late message skipped/.test(line)) c.lateSkipped += 1;
    else if (/Late reply gave up/.test(line)) { if (/armed=background/.test(line)) c.bgWindowsClosed += 1; else c.lostReplies += 1; }
    else if (/Turn failed|Background turn failed|Recovery failed/.test(line)) c.turnFailed += 1;
    else if (/Turn wait timed out .*delivered=0/.test(line)) c.timeoutNoReply += 1;
    else if (/Prompt reused/.test(line)) c.promptsReused += 1;
    else if (/Replaying journaled inbound/.test(line)) c.journalReplayed += 1;
    else if (/Journal entry dropped/.test(line)) c.journalDropped += 1;
    else if (/control: ensure restarting/.test(line)) c.restarts += 1;
    else if (/control: ensure timed out/.test(line)) c.ensureTimeouts += 1;
    if (/ ALERT /.test(line)) c.alerts += 1;
    if (/^\S+ ERROR /.test(line)) c.errors += 1;
  }
  return c;
}

const stats = (values) => {
  if (!values.length) return "n/a";
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return `median ${Math.round(sorted[Math.floor(sorted.length / 2)])} max ${Math.round(sorted.at(-1))} total ${Math.round(sum)}`;
};

function statusLine() {
  let s;
  try { s = JSON.parse(readFileSync(statusFile, "utf8")); } catch { return "status: unreadable"; }
  let running = "unknown";
  try {
    const pid = Number(readFileSync(path.join(home, "bridge.pid"), "utf8").trim());
    running = pid && existsSync(`/proc/${pid}`) ? "running" : "NOT running";
  } catch {}
  const visible = Array.isArray(s.groupsVisible) ? s.groupsVisible.length : "?";
  const missing = Array.isArray(s.groupsMissing) ? s.groupsMissing.length : 0;
  return [
    `bridge ${running} state=${s.state ?? "?"} groups=${visible}/${s.groupsConfigured ?? "?"}${missing ? ` MISSING=${missing}` : ""} heartbeat=${ago(s.updatedAt ?? s.heartbeatAt)} frame=${ago(s.lastFrameAt)} inflight=${s.inflightInbound ?? 0} oldestInboundMs=${s.oldestInboundMs ?? 0}${s.alert ? " ALERT" : ""}`,
    `since start: polls=${s.latePolls ?? "?"} pollErrors=${s.latePollErrors ?? "?"} lateTurnsPending=${s.lateTurnsPending ?? "?"} journalPending=${s.journalPending ?? "?"} groupChecks full/light=${s.groupChecksFull ?? "?"}/${s.groupChecksLight ?? "?"} pauses=${s.pausesDetected ?? "?"}`,
  ];
}

function incremental() {
  if (!existsSync(logFile)) { console.log(`no log at ${logFile}`); return 1; }
  const previous = loadOffset();
  const probe = readRange(logFile, Number.MAX_SAFE_INTEGER);
  const start = previous && previous.ino === probe.ino && previous.offset <= probe.size ? previous.offset : Math.max(0, probe.size - 256 * 1024);
  const { text, size, ino } = readRange(logFile, start);
  const complete = text.lastIndexOf("\n") + 1; // only whole lines; the rest is read next time
  const lines = text.slice(0, complete).split("\n").filter(Boolean);
  const c = count(lines);
  const drops = Object.entries(c.drops).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  const notable = Object.entries(c.drops).filter(([k]) => !/^(own-message|system-stub|reaction-not-on-bot-message|noise|duplicate-inflight)$/.test(k)).reduce((a, [, v]) => a + v, 0);
  const span = c.first ? `${kl(c.first)}..${kl(c.last)} KL` : "no new lines";
  console.log(...statusLine().slice(0, 1));
  console.log(`window ${span} lines=${lines.length}: pauses=${c.pauses} reconnects=${c.connected} fullGroupChecks=${c.fullChecks} light=${c.lightChecks} errors=${c.errors} alerts=${c.alerts} restarts=${c.restarts}`);
  console.log(`drops: ${drops} (notable=${notable}) outboundDropped=${c.outboundDropped}`);
  console.log(`late: delivered=${c.lateDelivered} skipped=${c.lateSkipped} pollFails=${c.lateFailed} (http5xx=${c.late500}) LOST_REPLIES=${c.lostReplies + c.timeoutNoReply + c.turnFailed} (gaveUp=${c.lostReplies} timeoutNoReply=${c.timeoutNoReply} turnFailed=${c.turnFailed}) journalReplayed=${c.journalReplayed} journalDropped=${c.journalDropped} promptsReused=${c.promptsReused}`);
  console.log(statusLine()[1]);
  if (!args.has("--no-advance")) saveOffset({ ino, offset: start + Buffer.byteLength(text.slice(0, complete)), at: new Date(nowMs).toISOString() });
  void size;
  return 0;
}

function daily() {
  if (!existsSync(logFile)) { console.log(`no log at ${logFile}`); return 1; }
  const probe = readRange(logFile, Number.MAX_SAFE_INTEGER);
  const { text } = readRange(logFile, probe.size - DAILY_MAX_BYTES);
  const since = nowMs - 24 * 3600_000;
  const lines = text.split("\n").filter((line) => (lineTime(line) ?? 0) >= since);
  const c = count(lines);
  const long = c.pauseSec.filter((s) => s > 180).length;
  const byHour = new Array(24).fill(0);
  for (const t of c.pauseTimes) byHour[new Date(t + 8 * 3600_000).getUTCHours()] += 1;
  console.log(`daily (last 24h to ${kl(nowMs)} KL): pauses=${c.pauses} (>3min=${long}, <=3min=${c.pauses - long}) pausedSec ${stats(c.pauseSec)}`);
  console.log(`reconnects=${c.connected} disconnects=${c.disconnects} fullGroupChecks=${c.fullChecks} light=${c.lightChecks} resume->connected s ${stats(c.resumeLatencyS)}`);
  console.log(`pauses by KL hour: ${byHour.map((n, h) => (n ? `${String(h).padStart(2, "0")}:${n}` : "")).filter(Boolean).join(" ") || "none"}`);
  console.log(`late: delivered=${c.lateDelivered} skipped=${c.lateSkipped} pollFails=${c.lateFailed} (http5xx=${c.late500}) lostReplies=${c.lostReplies + c.timeoutNoReply + c.turnFailed} errors=${c.errors} alerts=${c.alerts} restarts=${c.restarts}`);
  return 0;
}

process.exitCode = args.has("--daily") ? daily() : incremental();
