import { readFileSync } from "node:fs";
import { writeFileDurableSync } from "./durable-fs.js";

/** JSON with Buffers/Uint8Arrays (media keys inside raw WAMessages) kept as base64. */
function replacer(_key, value) {
  if (value && value.type === "Buffer" && Array.isArray(value.data)) return { __b64: Buffer.from(value.data).toString("base64") };
  if (value instanceof Uint8Array) return { __b64: Buffer.from(value).toString("base64") };
  return value;
}

function reviver(_key, value) {
  return value && typeof value === "object" && typeof value.__b64 === "string" && Object.keys(value).length === 1
    ? Buffer.from(value.__b64, "base64")
    : value;
}

export function journalKey(event) {
  return `${event?.chatId ?? "unknown"}|${event?.id ?? "unknown"}`;
}

/**
 * Write-ahead journal for accepted inbound WhatsApp messages. Baileys acks a
 * message to WhatsApp before the bridge sees it, and the queue lives in memory,
 * so an accepted message is written here (fsync'd) before it is dispatched and
 * removed once the agent has its prompt (or the message was dropped/answered).
 * Whatever is left at start-up (crash, SIGTERM with a queue) is replayed.
 * Note: a VM snapshot rollback restores this file too, so it cannot help there.
 */
export class InboundJournal {
  constructor(filename, { log = console, maxEntries = 500 } = {}) {
    this.filename = filename;
    this.log = log;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  load() {
    let raw;
    try {
      raw = readFileSync(this.filename, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return this;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw, reviver);
      for (const item of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        if (item?.key && item.event && Number.isFinite(item.at)) this.entries.set(item.key, { event: item.event, at: item.at });
      }
    } catch (error) {
      this.log.warn(`Inbound journal unreadable (${error.message}); starting empty`);
    }
    return this;
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    return this.entries.has(key);
  }

  add(event, at = Date.now()) {
    const key = journalKey(event);
    const { replayed: _replayed, ...stored } = event ?? {};
    this.entries.set(key, { event: stored, at });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.persist();
    return key;
  }

  remove(keys) {
    let changed = false;
    for (const key of [keys].flat()) changed = this.entries.delete(key) || changed;
    if (changed) this.persist();
    return changed;
  }

  list() {
    return [...this.entries.entries()].map(([key, value]) => ({ key, ...value }));
  }

  persist() {
    try {
      writeFileDurableSync(this.filename, `${JSON.stringify({ entries: this.list() }, replacer)}\n`);
    } catch (error) {
      this.log.warn(`Inbound journal write failed: ${error.message}`);
    }
  }
}
