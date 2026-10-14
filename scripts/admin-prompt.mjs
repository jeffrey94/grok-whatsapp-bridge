#!/usr/bin/env node
/**
 * Ask the RUNNING bridge to give one group's agent a one-off instruction from
 * the admin (e.g. "post a short notice about ..."). The agent's reply goes out
 * through the normal reply path, exactly once (dedupe by request id).
 *
 *   node scripts/admin-prompt.mjs --group <jid>@g.us --prompt "..."            # dry run
 *   node scripts/admin-prompt.mjs --group <jid>@g.us --prompt "..." --yes-post # queue it (MAY POST)
 *
 * Box-only: drops a request file into state/nudges/ (mode 700). Nothing arriving
 * from WhatsApp can create one.
 */
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { normalizeGroupJid } from "../src/core/routing.js";
import { queueNudge } from "../src/nudge-inbox.js";

const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const jid = normalizeGroupJid(value("group"));
const prompt = value("prompt");
if (!jid || !prompt?.trim()) {
  console.log('usage: node scripts/admin-prompt.mjs --group <jid>@g.us --prompt "<text>" [--config ./config.json] [--yes-post]');
  process.exit(2);
}
const config = loadConfig(value("config") ?? process.env.WA_BRIDGE_CONFIG ?? "config.json", { readToken: false });
const group = config.groups.find((entry) => entry.jid === jid);
if (!group) { console.error(`Group ${jid} is not in config.json groups.`); process.exit(2); }
if (!argv.includes("--yes-post")) {
  console.log(`DRY RUN: would send agent ${group.agent} in "${group.name ?? jid}" this admin prompt:\n${prompt.trim()}`);
  process.exit(0);
}
const queued = queueNudge(path.join(path.dirname(config.statusPath), "nudges"), { group: jid, prompt });
console.log(`Queued admin prompt id=${queued.id} for "${group.name ?? jid}". Watch bridge.log for 'Admin prompt sent' then 'Delivered'.`);
