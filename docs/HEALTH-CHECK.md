# Bridge health check

A short runbook for checking a running bridge. All commands are read-only unless
noted. Paths assume the default layout (`$BRIDGE_HOME` = the checkout,
`state/status.json`, `bridge.log`). Log timestamps are UTC.

## 1. One-line summary

```sh
npm run health          # status line + counters for the current log window
npm run health:daily    # last 24 h: pauses, reconnects, late/lost replies
deploy/whatsapp-bridge-control.sh status
```

## 2. `state/status.json`

| Field | Healthy | Notes |
| --- | --- | --- |
| `state` | `connected` | `connecting` / `reconnecting` are transient. `needs-pairing`, `logged-out`, `connection-replaced`, `forbidden`, `bad-session` are terminal: a human must act; `ensure` will not restart. |
| `pid` | a live process | `kill -0 <pid>` (read-only check). |
| `updatedAt` / `heartbeatAt` | under ~1 min old | Stale heartbeat = process hung or box paused. |
| `lastFrameAt` | recent | Last frame from WhatsApp. A long silence while connected forces a reconnect. |
| `connectedSince`, `reconnectAttempts`, `lastDisconnectCode`, `nextRetryInMs` | | Reconnect history of the current process. |
| `groupsConfigured` / `groupsVisible` / `groupsMissing` | missing empty | See section 3. |
| `inflightInbound`, `oldestInboundMs` | 0 / small | Messages accepted but not yet answered. See section 6. |
| `alert`, `alertAt` | absent | Set by the control script; clear with `clear-alert` after you fix the cause. |

## 3. Group check

After a full connect the log shows:

```
Group check configured=N visible=V missing=M
```

`missing > 0` means a configured group JID is not visible to the paired account
(bot removed, group re-created, wrong JID). A light reconnect (short outage)
logs `Group check skipped (light reconnect, ...) cached configured=... visible=... missing=...`
using the cached result.

## 4. Pauses and reconnects in the log

```sh
rg "Box was paused for about|WhatsApp disconnected code=|WhatsApp reconnecting|WhatsApp resuming after pause|socket silent for|ensure restarting bridge" bridge.log | tail -50
```

- `Box was paused for about Ns` — the box was suspended; the bridge refreshes the heartbeat and reconnects. Occasional short pauses are normal.
- `WhatsApp disconnected code=X; reconnect attempt N` — normal backoff. Many in a row, or a terminal code, needs attention.
- `control: ensure restarting bridge: <reason>` — the control script restarted it, with the reason.

## 5. Lost replies and late messages

```sh
rg "Late reply gave up|Turn wait timed out|Late message skipped|Late message not delivered|Delivered .* late=yes" bridge.log | tail -50
```

- **Lost reply**: `Late reply gave up` (not `armed=background`), a turn timeout with no reply, or a failed turn. `npm run health` reports these as `LOST_REPLIES`.
- `Late message skipped ... reason=`:
  - `unknown-prompt` — the entry is not tied to any prompt this bridge sent.
  - `prompt-not-pending` — the turn was already answered/retired (duplicate protection).
  - `too-old` — older than `lateMaxAgeMs` since the turn was armed.
  - `superseded` — a newer turn in the same chat was already answered (ordering guard; background-task turns are exempt).
- `Late message not delivered ... reason=chat-not-configured-for-agent` — the chat is no longer routed to that agent in the current config.

Skips are guards working as intended; investigate only if a user says a reply never arrived.

## 6. Before restarting: check inflight

Do not restart while work is in flight unless the bridge is clearly stuck.

```sh
jq '{state, inflightInbound, oldestInboundMs, updatedAt}' state/status.json
```

- `inflightInbound = 0`: safe to restart.
- `inflightInbound > 0` and `oldestInboundMs` small: wait for the turn to finish.
- `inflightInbound > 0` and `oldestInboundMs` very large with no log activity: stuck; restart. Accepted messages are in the write-ahead journal and are replayed on start (`journalReplayed` in the health summary).

## 7. Safe restart

1. Run sections 1–2; note `state` and any `alert`.
2. If `state` is terminal (e.g. `needs-pairing`, `logged-out`), restarting will not help: re-pair instead (`npm run pair`).
3. Check inflight (section 6).
4. `deploy/whatsapp-bridge-control.sh restart` (takes the lock, sends SIGTERM so the bridge drains and flushes state, starts, waits for `connected`). Never `kill -9` unless SIGTERM fails.
5. Confirm: `state=connected`, `Group check ... missing=0`, fresh heartbeat, and `journalReplayed` matches what was queued.
6. If an alert was set and the cause is fixed: `deploy/whatsapp-bridge-control.sh clear-alert`.

Do not post test messages into live groups to check health; use the log and `status.json`.
