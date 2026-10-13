/**
 * Per-chat FIFO queues plus photo-album / burst bundling. Adapted from the
 * Telegram bridge's update-dispatcher.js to a platform-neutral event shape:
 *
 *   event = { id, chatId, sender: { jid }, kind, text, ... }
 *
 * The handler (the bridge) supplies:
 *   queueKeyFor(event)          -> string (per-chat queue key)
 *   classifyForBundling(event)  -> { senderKey, role: "media"|"text"|"other", album? } | undefined
 *   handleEvent(eventOrBundle, options)
 *   handleError(eventOrBundle, error, options)
 *
 * A bundle is delivered to handleEvent as { ...firstEvent, bundled: [e1, e2, ...] }.
 *
 * Backlog batching (opt-in, options.batching = { minCount, maxAgeMs }): when a
 * unit (single event or closed bundle) reaches the head of its queue and other
 * units of the same chat are still waiting, and together they hold minCount or
 * more waiting units (or the oldest waited maxAgeMs or longer), they are merged into
 * one turn delivered as { ...firstEvent, batch: [unit1, unit2, ...], batchInfo }.
 * Each unit is an event or a { ...firstEvent, bundled } bundle. Units the
 * handler rejects via batchable(unit) === false (commands) run on their own.
 * Every merged unit's dispatch() promise settles with the batch's result.
 */
export const DEFAULT_BATCHING = Object.freeze({
  minCount: 2,
  maxAgeMs: 60_000,
});
export const DEFAULT_BUNDLING = Object.freeze({
  albumDebounceMs: 1_800,
  burstWindowMs: 3_000,
  maxWaitMs: 8_000,
  maxItems: 10,
});

function shutdownAbortError() {
  const error = new Error("Media bundle not processed: shutting down");
  error.name = "AbortError";
  return error;
}

export class Dispatcher {
  constructor(handler, options = {}) {
    this.handler = handler;
    this.log = options.log ?? console;
    this.chatQueues = new Map();
    this.bundles = new Map();
    this.bundlingEnabled = options.bundling !== false;
    this.bundling = {
      ...DEFAULT_BUNDLING,
      ...(options.bundling && typeof options.bundling === "object" ? options.bundling : {}),
    };
    this.batching = options.batching && typeof options.batching === "object"
      ? { ...DEFAULT_BATCHING, ...options.batching }
      : undefined;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    // chatId -> units waiting in a queue (only tracked when batching is on).
    this.waiting = new Map();
  }

  batchKeyFor(event) {
    return String(event?.chatId ?? "unknown");
  }

  register(unit) {
    if (!this.batching) return;
    const list = this.waiting.get(unit.batchKey) ?? [];
    list.push(unit);
    this.waiting.set(unit.batchKey, list);
  }

  unregister(unit) {
    const list = this.waiting.get(unit.batchKey);
    if (!list) return;
    const index = list.indexOf(unit);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) this.waiting.delete(unit.batchKey);
  }

  unitEvent(unit) {
    return unit.items.length === 1 ? unit.items[0] : { ...unit.items[0], bundled: [...unit.items] };
  }

  unitArrivedAt(unit) {
    const stamped = unit.items.map((item) => item?.receivedAt).filter(Number.isFinite);
    return stamped.length ? Math.min(...stamped) : unit.firstAt;
  }

  isBatchable(unit) {
    if (typeof this.handler.batchable !== "function") return true;
    try {
      return this.handler.batchable(this.unitEvent(unit)) !== false;
    } catch {
      return false;
    }
  }

  /** Run a unit at the head of its queue, merging the chat's waiting backlog when due. */
  async runUnit(unit, options) {
    if (unit.consumed) return unit.batchTask;
    this.unregister(unit);
    if (this.batching && this.isBatchable(unit)) {
      const others = (this.waiting.get(unit.batchKey) ?? [])
        .filter((other) => !other.consumed && other.ready !== false && this.isBatchable(other));
      const units = [unit, ...others];
      const count = units.reduce((sum, u) => sum + u.items.length, 0);
      const now = this.now();
      const oldestAt = Math.min(...units.map((u) => this.unitArrivedAt(u)));
      const oldestAgeMs = Math.max(0, now - oldestAt);
      // A photo bundle is already one turn: count waiting turns, not items.
      const byCount = units.length >= this.batching.minCount;
      const byAge = this.batching.maxAgeMs > 0 && oldestAgeMs >= this.batching.maxAgeMs;
      if (byCount || byAge) {
        const batchEvent = {
          ...unit.items[0],
          batch: units.map((u) => this.unitEvent(u)),
          batchInfo: { count, oldestAgeMs, reason: byCount ? "backlog" : "stale" },
        };
        this.log.info(`Backlog batch chat=${unit.batchKey} messages=${count} units=${units.length} oldestAgeMs=${oldestAgeMs}`);
        const task = this.runEvent(batchEvent, options);
        for (const other of others) {
          other.consumed = true;
          other.batchTask = task;
          this.unregister(other);
        }
        return task;
      }
    }
    return this.runEvent(this.unitEvent(unit), options);
  }

  queueKeyFor(event) {
    return typeof this.handler.queueKeyFor === "function"
      ? this.handler.queueKeyFor(event)
      : String(event?.chatId ?? "unknown");
  }

  enqueue(key, run) {
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    this.chatQueues.set(key, task);
    void task.finally(() => {
      if (this.chatQueues.get(key) === task) this.chatQueues.delete(key);
    }).catch(() => {});
    return task;
  }

  async runEvent(event, options) {
    try {
      return await this.handler.handleEvent(event, options);
    } catch (error) {
      if (options.signal?.aborted || error.name === "AbortError") throw error;
      this.log.error(`Bridge event failed: ${error.message}`);
      await this.handler.handleError?.(event, error, options);
    }
  }

  classify(event) {
    if (!this.bundlingEnabled || typeof this.handler.classifyForBundling !== "function") return undefined;
    try {
      return this.handler.classifyForBundling(event);
    } catch (error) {
      this.log.error(`Media bundle classification failed: ${error.message}`);
      return undefined;
    }
  }

  dispatch(event, options = {}) {
    const classification = this.classify(event);
    if (classification?.senderKey) {
      const open = this.bundles.get(classification.senderKey);
      if (classification.role === "media") {
        return open
          ? this.addToBundle(open, event, classification)
          : this.openBundle(event, classification, options);
      }
      if (open && classification.role === "text") {
        // The sender's description right after the photos becomes the bundle text.
        open.items.push(event);
        this.closeBundle(open, "text");
        return open.task;
      }
      if (open) this.closeBundle(open, "flush");
    }
    if (!this.batching) return this.enqueue(this.queueKeyFor(event), () => this.runEvent(event, options));
    const unit = { batchKey: this.batchKeyFor(event), items: [event], firstAt: this.now(), consumed: false };
    this.register(unit);
    return this.enqueue(this.queueKeyFor(event), () => this.runUnit(unit, options));
  }

  openBundle(event, classification, options) {
    let resolveClosed;
    const bundle = {
      senderKey: classification.senderKey,
      queueKey: this.queueKeyFor(event),
      items: [event],
      firstAt: Date.now(),
      lastAlbum: classification.album === true,
      closed: false,
      aborted: false,
      reason: undefined,
      timer: undefined,
      closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
      batchKey: this.batchKeyFor(event),
      ready: false,
      consumed: false,
    };
    this.register(bundle);
    bundle.resolveClosed = resolveClosed;
    this.bundles.set(bundle.senderKey, bundle);
    if (options.signal) {
      bundle.signal = options.signal;
      bundle.onAbort = () => this.closeBundle(bundle, "shutdown", { aborted: true });
      if (options.signal.aborted) bundle.onAbort();
      else options.signal.addEventListener("abort", bundle.onAbort, { once: true });
    }
    if (!bundle.closed) this.scheduleBundle(bundle);
    // Reserve the queue slot now so ordering with other events in the chat holds.
    bundle.task = this.enqueue(bundle.queueKey, async () => {
      await bundle.closedPromise;
      if (bundle.consumed) return bundle.batchTask;
      if (bundle.aborted || options.signal?.aborted) {
        this.unregister(bundle);
        this.log.error(`Media bundle not processed at shutdown items=${bundle.items.length}`);
        throw shutdownAbortError();
      }
      this.log.info(`Media bundle flush items=${bundle.items.length} reason=${bundle.reason} waitedMs=${Date.now() - bundle.firstAt}`);
      if (this.batching) return this.runUnit(bundle, options);
      return this.runEvent(this.unitEvent(bundle), options);
    });
    return bundle.task;
  }

  addToBundle(bundle, event, classification) {
    bundle.items.push(event);
    bundle.lastAlbum = classification.album === true;
    if (bundle.items.length >= this.bundling.maxItems) this.closeBundle(bundle, "max-items");
    else if (Date.now() - bundle.firstAt >= this.bundling.maxWaitMs) this.closeBundle(bundle, "max-wait");
    else this.scheduleBundle(bundle);
    return bundle.task;
  }

  scheduleBundle(bundle) {
    clearTimeout(bundle.timer);
    const debounceMs = bundle.lastAlbum ? this.bundling.albumDebounceMs : this.bundling.burstWindowMs;
    const now = Date.now();
    const debounceAt = now + debounceMs;
    const capAt = bundle.firstAt + this.bundling.maxWaitMs;
    const reason = capAt <= debounceAt ? "max-wait" : "debounce";
    bundle.timer = setTimeout(() => this.closeBundle(bundle, reason), Math.max(0, Math.min(debounceAt, capAt) - now));
  }

  closeBundle(bundle, reason, { aborted = false } = {}) {
    if (bundle.closed) return;
    bundle.closed = true;
    bundle.ready = !aborted;
    bundle.reason = reason;
    bundle.aborted = aborted;
    clearTimeout(bundle.timer);
    bundle.timer = undefined;
    if (this.bundles.get(bundle.senderKey) === bundle) this.bundles.delete(bundle.senderKey);
    if (bundle.signal && bundle.onAbort) bundle.signal.removeEventListener("abort", bundle.onAbort);
    bundle.resolveClosed();
  }

  flushBundles(reason = "flush") {
    for (const bundle of [...this.bundles.values()]) this.closeBundle(bundle, reason);
  }

  pendingBundleCount() {
    return this.bundles.size;
  }

  async drain() {
    if (this.bundles.size) this.flushBundles("drain");
    await Promise.allSettled(this.chatQueues.values());
  }
}
