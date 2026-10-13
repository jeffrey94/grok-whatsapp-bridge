# grokbot-whatsapp-bridge

An unofficial, self-hosted bridge between **WhatsApp** and **Grok Bot's local
gateway**. It is the WhatsApp twin of `grokbot-telegram-bridge`: people message
a WhatsApp number (in a DM or an allowlisted group), the bridge hands the
message to a Grok Bot agent, and it posts the agent's reply (text and files)
back into the same chat.

> **Unofficial. Use a spare number only.** This bridge is built on
> [Baileys](https://github.com/WhiskeySockets/Baileys) (`baileys` 7.0.0-rc14, a pinned pre-release; upgrade deliberately and re-run the tests),
> an unofficial WhatsApp Web client library. It links to WhatsApp as a
> "linked device", the same way WhatsApp Web does. **This is not the official
> WhatsApp Business API** and is not affiliated with or endorsed by WhatsApp or
> Meta. WhatsApp can restrict or ban numbers that behave like bots, so link a
> spare number you can afford to lose, never your main or business number, and
> read [Ban-risk rules](#ban-risk-rules) before going live.

> Status: tested live on a linked spare number across several groups. The
> offline test suite (`npm test`) never contacts WhatsApp.

## Quick start

```sh
git clone https://github.com/jeffrey94/grok-whatsapp-bridge.git /home/box/grokbot-whatsapp-bridge   # control script default; else set BRIDGE_HOME
cd /home/box/grokbot-whatsapp-bridge
npm ci --ignore-scripts                    # or: npm install
npm test                                   # offline, never contacts WhatsApp
cp config.example.json config.json
chmod 600 config.json                      # the bridge refuses any other mode
# edit config.json: defaultAgent, dms, groups (placeholders are rejected)
npm run pair -- --code +60123456789        # your SPARE number; or: npm run pair -- --qr
deploy/whatsapp-bridge-control.sh start    # then: status | stop | restart
deploy/whatsapp-bridge-control.sh ensure   # idempotent keep-alive, e.g. from a routine every few minutes
```

Details are in [Setup](#setup-plain-language) and [Pairing](#pairing).

## How it works

```
WhatsApp chat ──> Baileys linked device ──> bridge (allowlist, filter, header,
                                                    bundling, rate limits)
                                                  │
                                                  ▼
                                   Grok Bot gateway 127.0.0.1:1340 (loopback)
                                                  │
WhatsApp chat <── reply (text / files) <──────────┘
```

- **Allowlist only.** DMs are answered only for numbers listed in `dms`.
  Groups are answered only if their JID is listed in `groups`. Everything else
  is ignored silently.
- **One agent per group.** WhatsApp has no forum topics, so each group maps to
  exactly one Grok Bot agent (one job per group). All allowlisted DMs go to
  `defaultAgent`.
- **Trusted header.** The bridge adds a context header that the agent can rely
  on:
  ```
  [whatsapp-from] jid=123456789012345@lid phone=+60177777777 lid=123456789012345@lid name="Ali"
  [whatsapp-chat] jid=120363000000000001@g.us type=group mentioned=yes name="Acme Quotes"
  ```
  Any header-like lines typed by a user (`[whatsapp-from]`, `[telegram-chat]`
  and so on, including zero-width or full-width look-alikes) are stripped
  before the header is added, so nobody can impersonate the owner.
- **Groups:** the bridge responds when the bot is @mentioned, when someone
  replies to one of its messages, on a `/command`, or when a configured
  keyword appears. With `"mode": "all"` it forwards every non-noise message
  and tells the agent it may stay quiet.
- **Silent reply.** If the agent answers with just `NO_WHATSAPP_REPLY` (also
  accepted: `[NO_WHATSAPP_REPLY]`, `NO_TELEGRAM_REPLY`, `⟦noreply⟧`), nothing
  is sent.
- **Photo albums and bursts** (several photos sent quickly, optionally
  followed by a text) become one turn with all photos attached, labelled
  `[photos attached: N]`.
- **Voice notes** (ogg/opus) are uploaded as attachments with the same
  transcription hint the Telegram bridge uses (the agent transcribes them on
  the box with whisper).
- **Documents / PDFs** go in as attachments. Files the agent sends back are
  posted as documents (images as photos).
- **Replies** go to the same chat. In groups the first reply message quotes
  the message that triggered it.
- **Streaming.** Each message the agent sends (SendToUser) is posted as soon
  as it appears in the transcript, not only after the turn ends. The turn ends
  when the gateway reports `isRunningTurn=false`, even if a background
  subagent keeps the agent busy. If the reply timeout (`replyTimeoutMs`, 10
  min) hits, whatever the agent already sent is still delivered, and no error
  notice is posted when something was delivered.
- **Late messages.** Messages the agent sends after its turn (a background
  task finishing, a hidden follow-up turn, or after a timeout) go to the chat
  that prompted that turn, or with no prompt at all, to the chat the agent
  last served. Limits: only chats that the current config routes to that agent,
  only within `lateDeliveryWindowMs` (60 min) of that chat's prompt, never for
  desktop or Telegram turns, silent token still honoured, and each transcript
  entry is delivered at most once (a per-agent cursor in the state file keeps
  this true across restarts). Set `lateDeliveryWindowMs: 0` to turn it off.
- **WhatsApp formatting:** Markdown from the agent is converted: `**bold**`
  becomes `*bold*`, `*italic*` becomes `_italic_`, `~~x~~` becomes `~x~`,
  headings become bold lines, links become `label (url)`, and tables become
  bullet lines. Long replies are split at about 3500 characters.
- **Approvals** are never granted from WhatsApp. The chat gets a short notice
  to approve on the Grok Bot desktop app.
- **Config is file-only.** Nothing arriving from WhatsApp can change which
  agent a chat uses, the allowlist, or any agent setup. The only chat commands
  are `/help` and `/status`. Anything else (such as `/use`) is passed to the
  agent as plain text.

## Progress, reactions and quoting

| Key | Scope | Default | What it does |
|---|---|---|---|
| `typingRefreshMs` | global | `10000` | Re-send WhatsApp "composing" this often while an agent turn runs. Stops on the first reply, a silent reply, the end of the turn or a timeout. `0` = composing only once at the start. Each presence call keeps the 3 s timeout. Needs `typingIndicator` (default on). No typing for `mode: "all"` soft forwards or reaction turns. |
| `typingRefresh` | per group | `true` | `false` = no refresh in that group. |
| `slowAck` | per group | `false` | Opt-in. If a turn has run for `slowAckMs` and nothing was sent yet, send ONE neutral holding line in the sender's language (`稍等，我在处理中 🙏` if their text has Chinese, else `One moment, working on it 🙏`). Not quoted, so the real reply still quotes the trigger. Never for all-mode soft forwards, reaction turns or check triggers, and never in a group with `progressBubbles: false`. Off by default because a turn may end in a silent reply, and that can't be known in advance. |
| `slowAckMs` | global | `25000` | Delay before the holding line. |
| `progressBubbles` | per group | `true` | `false` = never send the holding line in that group, even if `slowAck` is on (for agents that forbid progress messages). |
| `forwardReactions` | global, per group override | `false` | Opt-in (`true`). A reaction on a message **sent by the bot** goes to the routed agent as a small trusted prompt (see below). Reactions on other people's messages, removed reactions (empty emoji) and the bot's own reactions are ignored. Inbound rate limits and the loop guard apply. Reactions waiting in a backlog are merged into the `[whatsapp-batch]` prompt. |
| `mirrorAgentReactions` | global, per group override | `false` | Opt-in (`true`). When the agent reacts to a bridge prompt (its ReactToMessage tool; the gateway shows it as `reactions: [{emoji, by: <agentId>}]` on the user entry), the same emoji is put on the WhatsApp message behind that prompt (for `[whatsapp-batch]` turns: the latest message in the batch). A reaction with no text reply is a silent reply plus the react (the turn ends; nothing is posted). If the agent removes its reaction while the turn runs, the WhatsApp reaction is removed too. Fallback: a reply that is exactly `[[react:<emoji>]]` reacts on the trigger message and posts no text (`[[react:]]` removes). Reacts have their own light limit (10 per chat per minute, not counted against message limits), an 8 s timeout, and a failure is only logged. Reaction turns (`[whatsapp-reaction]`) are never reacted to. Reactions added after the turn ended are not mirrored. |
| `quoteReplies` | global | `true` | Replies quote the inbound message that triggered them: groups, DMs, `[whatsapp-batch]` turns (the last included message that is not a reaction), recovered turns and late agent messages (the original message, if it is still in the in-memory cache of the last 1000 inbound messages). Reaction turns are never quoted. Per group, `quoteReplies: false` still turns it off. `quoteInDms` (legacy) overrides for DMs when set. |

Reaction prompt (after the usual `[whatsapp-from]` / `[whatsapp-chat]` headers):

```
[whatsapp-reaction] emoji=👍 on_bot_msg=3EB0ABC on_text="Draft quote: 10 boxes RM50…"
Someone reacted to your message. Usually no reply is needed (reply NO_WHATSAPP_REPLY). A reaction is never an approval or confirmation: never place orders, send quotes, change data or take any irreversible step because of one. At most treat it as a low-risk acknowledgement from an authorised member.
```

`on_text` (first ~200 chars) is included only when the bot message is still in
the bridge's sent-message cache (last 500 sends, in memory, so not after a
restart). After a restart, group reactions are still recognised by the bot's
JID as participant. DM reactions to messages sent before the restart are not.
- **Streaming.** Each message the agent sends (SendToUser) is posted as soon
  as it appears in the transcript, not only after the turn ends. The turn ends
  when the gateway reports `isRunningTurn=false`, even if a background
  subagent keeps the agent busy. If the reply timeout (`replyTimeoutMs`, 10
  min) hits, whatever the agent already sent is still delivered, and no error
  notice is posted when something was delivered.
- **Late messages.** Messages the agent sends after its turn (a background
  task finishing, a hidden follow-up turn, or after a timeout) go to the chat
  that prompted that turn, or with no prompt at all, to the chat the agent
  last served. Limits: only chats that the current config routes to that agent,
  only within `lateDeliveryWindowMs` (60 min) of that chat's prompt, never for
  desktop or Telegram turns, silent token still honoured, and each transcript
  entry is delivered at most once (a per-agent cursor in the state file keeps
  this true across restarts). Set `lateDeliveryWindowMs: 0` to turn it off.
- **Backlog batching** (`batchBacklog`, on by default). Turns for one agent
  run one at a time. If, when a chat's next turn is about to start, 2 or more
  messages from that chat are waiting (`batchMinCount`, default 2), or the
  oldest one has waited `batchMaxAgeMs` (default 60000 ms) or longer (a slow turn
  past `turnQueueHoldMs`, or a box pause), they all go to the agent as ONE
  catch-up prompt instead of one prompt each:
  ```
  [whatsapp-batch] count=3 oldest_age_s=140 reason=backlog
  Several messages arrived while you were busy or offline. Read them all, then reply ONCE, … If nothing needs a reply, reply NO_WHATSAPP_REPLY.

  [whatsapp-batch-item] n=1 of=3 msg=<id> time=<ISO UTC> age_s=140
  [whatsapp-from] …
  [whatsapp-chat] … mentioned=yes
  <text>
  ```
  (`reason=stale` when only the age threshold fired.) Each message keeps its own
  trusted headers, in arrival order; the group filter (mention / reply /
  keyword / all-mode) is applied per message, so unaddressed chatter is left
  out. All attachments from the batched messages are uploaded together. The
  reply quotes the latest included message (same `quoteReplies` rules). Rate
  limits count the batch as one inbound turn; silent token, loop guards, late
  delivery and in-flight tracking are unchanged, and every merged message is
  marked handled when the batch turn finishes. Commands (`/help`, `/status`,
  `check pending`) are never merged. Config: `"batchBacklog": false` turns it off;
  `"batchMinCount": 3`; `"batchMaxAgeMs": 0` disables the age trigger.
- **Offline catch-up.** When the box is paused or the socket reconnects,
  messages sent meanwhile arrive as a `messages.upsert` of type `append`
  instead of `notify`. Those with a timestamp within `catchUpMaxAgeMs`
  (default 20 min) are handled like live messages (logged `Catch-up inbound`,
  then `Inbound accepted`) and go through the normal path, so backlog batching
  merges them into one `[whatsapp-batch]` prompt per chat. They are deduped by
  message id (never handled twice, also if WhatsApp re-delivers them as
  `notify`), and the bot's own messages are skipped. Older catch-up messages
  are dropped with `Drop inbound reason=catchup-too-old`. For catch-up
  messages the age limit is the larger of `maxMessageAgeSec` and
  `catchUpMaxAgeMs`; live messages keep `maxMessageAgeSec`.
- **WhatsApp formatting:** Markdown from the agent is converted: `**bold**`
  becomes `*bold*`, `*italic*` becomes `_italic_`, `~~x~~` becomes `~x~`,
  headings become bold lines, links become `label (url)`, and tables become
  bullet lines. Long replies are split at about 3500 characters.
- **Approvals** are never granted from WhatsApp. The chat gets a short notice
  to approve on the Grok Bot desktop app.
- **Config is file-only.** Nothing arriving from WhatsApp can change which
  agent a chat uses, the allowlist, or any agent setup. The only chat commands
  are `/help` and `/status`. Anything else (such as `/use`) is passed to the
  agent as plain text.

## Per-group members, roles and proactive checks

Optional per-group keys in `config.json`. Groups that don't set them behave
exactly as before. Example: a fictional supplier group, "Acme Hardware x
Example Finance (DEMO)", where a financing company's relationship manager and
the customer's owner talk to a trade-line assistant agent:

```json
{ "jid": "120363000000000003@g.us", "agent": "<agent-id>", "mode": "all",
  "members": [
    { "name": "Sam (relationship manager)", "role": "BDM", "ids": ["+60120000001", "100000000000001@lid"] },
    { "name": "Lee (owner)", "role": "owner", "authorised": "Y", "ids": ["+60120000002"] }
  ],
  "defaultMember": { "name": "Company staff", "role": "company", "authorised": "Y" },
  "allowNudge": true, "checkCommand": true }
```

Roles: `BDM` (the relationship manager / account manager on the provider's
side; `admin` works the same) gets `access=full`; any other role with
`authorised: "Y"` gets `access=account`; everyone else gets `access=faq-only`.
`defaultMember` (optional, only with `members`) applies to senders not on the
list and can never be `BDM`/`admin`.

- **`members`**: the bridge works out who is speaking from WhatsApp metadata
  (phone or LID; a bare `@lid` sender is looked up in Baileys' local LID map or
  the group's participant list, only for groups with a member list) and adds a
  trusted line the agent can rely on:
  `[whatsapp-role] role=BDM|owner|unknown authorised=Y|N access=full|account|faq-only`.
  If WhatsApp gives only a LID, the phone comes from the member list
  (`phone_source=config`). Senders not on the list are `role=unknown
  access=faq-only` (unless `defaultMember` is set); they still reach the agent (no `allowSenders`), and a
  code backstop replaces any reply to them that contains RM amounts, facility
  codes (`FAC-X-nnnn`) or invoice numbers with a fixed decline
  (`faqOnlyBlockedReply` to override, `"faqOnlyGuard": false` to disable).
- **`checkCommand`**: a member with `access=full` (the relationship manager) can type
  `@bot check pending` (also `check pending`, `/check`, `/pending`). The bridge
  replaces it with the scheduled-check prompt and a trusted
  `[whatsapp-trigger] kind=check-pending source=bdm` line. From anyone else the
  words are passed through as a normal message.
- **`allowNudge`** + `scripts/nudge.mjs`: a deliberate, operator-only exception
  to reply-only. On the box:
  ```sh
  node scripts/nudge.mjs --group <jid>@g.us             # dry run, posts nothing
  node scripts/nudge.mjs --group <jid>@g.us --yes-post  # may post into the group
  ```
  The script only drops a request file into `state/nudges/` (mode 700); the
  running bridge picks it up within ~2 s, sends the group's agent a synthetic
  `[scheduled check]` prompt and delivers its answer through the normal reply
  path (rate limits, silent token). Max one per group per 2 minutes; requests
  older than 10 minutes are discarded. Nothing is scheduled automatically.

## Safety limits built in

| Guard | Default |
|---|---|
| Reply-only: can only send to a chat that messaged it in the last 15 min (agent replies and late messages: up to `lateDeliveryWindowMs`, 60 min, after that chat's prompt) | `replyWindowMs: 900000` |
| Max outbound messages per chat per minute | `6` |
| Max outbound messages overall per minute | `20` |
| Max inbound turns per sender per minute | `8` |
| Max inbound turns per chat per minute | `20` |
| Pause between outbound messages | `sendDelayMs: 1200` |
| One turn holds its agent's queue for at most this long before the next message is handled (0 = no cap) | `turnQueueHoldMs: 120000` |
| A rate-limited reply is not dropped: the send budget is refunded and the bridge waits for the window to free up | always |
| Ignore own messages, Meta AI and other bot JIDs, and echoes of our own recent text | always |
| Ignore status broadcasts, newsletters, broadcast lists, reactions and protocol messages | always |
| Ignore messages older than `maxMessageAgeSec` (600 s), for example after downtime | always |
| No history sync, not shown as "online", the bridge never marks messages read | always |
| libsignal console dumps (session objects with private keys) are dropped or redacted before they reach `bridge.log` | always |
| Stray promise rejections and exceptions are logged and the process keeps running; reconnects keep the process alive | always |

## Mentions, health and recovery

- **Real @mentions.** When an agent reply contains `@<digits>` (or `@+<digits>`,
  7-15 digit phone number) for someone who is in that chat, the bridge sends a
  real WhatsApp mention (it notifies them). In LID-addressed groups the token is
  rewritten to the participant's LID. Unknown numbers stay plain text.
- **Freeze protection.** WhatsApp calls have timeouts (send 90 s, typing
  3 s), so one stuck call cannot block a chat; `turnQueueHoldMs` (default
  120000) caps how long a turn holds its agent's queue.
- **Dead-connection watchdog.** If a "connected" socket sees no frame for
  150 s, the bridge forces a reconnect. `state/status.json` carries health
  fields (event-loop lag, oldest in-flight inbound, in-flight count) and
  `deploy/whatsapp-bridge-control.sh ensure` uses them; restart reasons are
  logged.
- **Pause detection.** After the box was paused or suspended (a clock jump of
  more than 10 s), the bridge reconnects cleanly instead of treating the gap as
  a dead socket.

### Health summary and quiet keep-alive

- `npm run health` prints a compact read-only summary (process, connection,
  last frame, reconnects, pauses, pending/late turns, recent errors).
  `npm run health:daily` covers the last 24 hours. It prints no secrets.
  `deploy/health-summary.sh` wraps it for a keep-alive routine.
- Suggested routine: every 15 minutes run `ensure` then the health summary;
  stay silent when healthy, alert only when something needs the operator, and
  send one short daily summary of pauses and reconnects.
- Inbound messages are journaled to disk before they reach an agent and
  replayed after a restart; state files are written atomically with fsync.

## Requirements

- Node.js 20.6 or newer (tested with 20.19.2), on the same box as Grok Bot.
- Grok Bot's gateway on `http://127.0.0.1:1340`, with the token in
  `gateway.json` at **mode 600**. The bridge refuses a token file readable by
  group or other users (`chmod 600 /home/box/sand-data/gateway.json`; the
  skill notes that this can reset after gateway restarts).
- A **spare WhatsApp number** on a phone (see ban-risk rules).

## Setup (plain language)

1. **Install**:
   ```sh
   cd /home/box/grokbot-whatsapp-bridge
   npm ci --ignore-scripts
   npm test
   ```
2. **Create the config** from the example and lock it down:
   ```sh
   cp config.example.json config.json
   chmod 600 config.json
   ```
   Fill in:
   - `defaultAgent`: the Grok Bot agent id that answers DMs.
   - `dms`: the phone numbers allowed to DM the bot (`"+60123456789"`),
     optionally also their `…@lid` id.
   - `groups`: one entry per group: `jid` (`…@g.us`), `agent`, `mode`
     (`mention` or `all`), optional `keywords` and `allowSenders`.

   Placeholders like `<group-id>` are rejected at startup.
3. **Pair the spare number** (see below). This creates `auth/` (mode 700).
4. **Find group JIDs.** Add the bridge number to the groups, then start the
   bridge once. It writes `state/groups.json` (mode 600) listing every group
   the account is in (`jid`, `subject`, `configured`). Copy the JIDs you want
   into `config.json` and restart. Nothing is posted to any chat.
5. **Start, check and stop:**
   ```sh
   deploy/whatsapp-bridge-control.sh start
   deploy/whatsapp-bridge-control.sh status
   deploy/whatsapp-bridge-control.sh stop
   ```
6. **Keep it running** (only once the operator agrees): a routine that runs
   `deploy/whatsapp-bridge-control.sh ensure` every few minutes. `ensure`:
   - starts the bridge if it is dead and waits up to 60 s for "connected";
   - restarts it if its heartbeat is older than 5 minutes;
   - exits `3` and does **not** restart after a terminal state
     (logged out, needs pairing, replaced, forbidden, bad session);
   - exits `4` if it is not connected, and `5` with a warning if a configured
     group is not visible to the account.

### Config example

See [`config.example.json`](config.example.json) (placeholders only). The
minimum is:

```json
{
  "gateway": { "url": "http://127.0.0.1:1340", "tokenFile": "/home/box/sand-data/gateway.json" },
  "defaultAgent": "<default-agent-id>",
  "dms": [{ "id": "+<owner-phone-digits>", "name": "Owner" }],
  "groups": [
    { "jid": "<group-id>@g.us", "name": "Quotes", "agent": "<quotes-agent-id>", "mode": "mention" }
  ]
}
```

The gateway URL must be loopback (`127.0.0.1`, `::1` or `localhost`). Other
hosts are refused.

### Sample workbot: quotation group

[`config.example.quotes.json`](config.example.quotes.json) maps one group
("Acme Quotes") to a quotation agent in `mention` mode with the keywords
`报价` / `quote` / `quotation` and a staff allowlist. How staff use it:

- Start a quote with `@bot 报价: ...` (or any message containing a keyword).
- Answer questions and confirm (`确认` / `OK`) by **swipe-replying to the
  bot's draft**. A bare `确认` or `OK` that is not a reply and has no mention
  is ignored in mention mode (`ok` is also on the noise list).
- The agent's final text and the PDF are posted back to the same group as
  a quoted text plus a document.

List staff by phone **and** LID (`<digits>@lid`) where known. In LID groups
WhatsApp does not always include the phone number, and a sender that matches
neither entry is dropped (`sender-not-allowed-in-group`).

`scripts/sample-quotes-live.mjs` replays this flow against the **real** local
gateway with the offline fake socket (it wakes the mapped agent, so it needs
`--yes-wake-real-agent` and is not part of `npm test`). Nothing goes to WhatsApp.

## Pairing

Run by the operator, on purpose, with the spare phone in hand.


Pairing links the bridge to the spare number as a linked device. Stop the
bridge first. Either method gives you about 3 minutes.

**Option A: pairing code (easiest from a phone)**

```sh
npm run pair -- --code +60XXXXXXXXX      # the SPARE number, full international format
```

The terminal prints an 8-character code, which is also saved to
`state/pairing-code.txt` (mode 600). On the spare phone go to **WhatsApp >
Settings > Linked devices > Link a device > Link with phone number instead**
and enter the code.

**Option B: QR code**

```sh
npm run pair -- --qr                      # prints a QR in the terminal
npm run pair -- --qr --png ./state/pair-qr.png
```

The QR is printed in the terminal and saved as a PNG (mode 600) that can be
shown in the desktop chat. On the spare phone go to **Linked devices > Link a
device** and scan it. It refreshes up to 6 times, then gives up.

After "Done: paired=true", start the bridge. The pairing code or PNG file is
deleted afterwards. If an old or half-finished session exists, `pair` refuses
to continue. Add `--move-partial` to move it aside (it is never deleted).

**If WhatsApp logs the device out**, the bridge stops, writes
`state/status.json` with `"state": "logged-out", "alert": true`, and does not
retry. Re-pair, then run `deploy/whatsapp-bridge-control.sh clear-alert` and
start it again.

## Ban-risk rules

WhatsApp does not allow unofficial clients and bans numbers that look
automated. To keep the risk low:

1. **Use a spare, warmed-up SIM.** Never use your main or business
   number. Use a number that has been used normally by a person for a while
   (profile photo, some real chats) before linking.
2. **Reply-only.** The bridge never starts conversations. It can only answer
   a chat that messaged it in the last 15 minutes. Don't add broadcast or
   outreach features.
3. **Low volume.** Keep the rate limits at or below the defaults. Few chats,
   known people, small groups.
4. **Known contacts only.** Keep the allowlist to people who have the number
   saved.
5. **No bulk group adds or links, and no messaging strangers.**
6. **Telegram stays the fallback.** Keep the Telegram bridge running. If the
   WhatsApp number is restricted, use Telegram while it is sorted out.
7. **Stop on trouble.** A 403 (forbidden) or logged-out state stops the
   bridge. Check the phone before re-pairing, and don't loop re-pairs.

## Feature parity with the Telegram bridge

| Feature | Telegram bridge | WhatsApp bridge | Notes |
|---|---|---|---|
| Private-chat allowlist | user ids | phone numbers / JIDs / LIDs | Matches PN or LID forms of the same person |
| Group allowlist | chat ids | group JIDs | |
| Routing | topic to agent, `/use` per chat | one agent per group; DMs to `defaultAgent` | **Gap:** no topics in WhatsApp; no `/use` (config is file-only by design) |
| Trusted context header + spoof strip | `[telegram-from]` / `[telegram-chat]` | `[whatsapp-from]` / `[whatsapp-chat]` | Strips both WhatsApp and Telegram header look-alikes |
| Group filter (mention / reply / all / keywords) | yes | yes | Mentions detected via `mentionedJid` (PN or LID) |
| Silent-reply token | `NO_TELEGRAM_REPLY` | `NO_WHATSAPP_REPLY` (+ Telegram token accepted) | |
| Photo album / burst bundling | yes | yes | Same dispatcher logic, generic events |
| Voice notes | ogg, whisper hint | ogg/opus, same hint | |
| Documents / PDFs in and out | yes | yes | 20 MB inbound limit |
| Replies quote the trigger in groups | reply_to | `quoted` | DMs not quoted (`quoteInDms`) |
| Formatting | Telegram HTML | WhatsApp `*bold*` / `_italic_`, no tables | |
| Per-chat queues | yes | yes (one FIFO per agent) | |
| Rate limits / loop guard | noise filter, no outbound caps | yes, stricter (reply window, per-chat and global caps, echo guard) | |
| Approvals | inline buttons in chat | **handed to desktop** with a notice | **Gap by design:** WhatsApp buttons are unreliable on linked devices |
| `/agents`, `/skills`, `/run`, `/mirror`, `/use` | yes | **no** | **Gap by design:** only `/help`, `/status` |
| Desktop mirror / routine widgets | yes | **no** | **Gap** |
| Reactions (👀 / ✅) | yes | **no** | **Gap:** fewer automated signals |
| Id discovery | logs chat/topic ids | `state/groups.json` from the startup group check | |
| Detect other bots | `is_bot` flag | Meta AI / `@bot` JIDs + echo detection | **Weaker:** WhatsApp has no is_bot flag |
| Restart recovery | Telegram redelivers updates + pending turns | pending turns resumed; missed messages not replayed | **Gap:** no history sync by design |
| Control script | bridge-control.sh | whatsapp-bridge-control.sh (+ status file, terminal-state stop, group check) | |
| Auth | bot token | Baileys multi-file auth in `auth/` (700/600) | Baileys calls its file store "not for production"; fine at low volume |

## Development

```sh
npm test          # unit + offline end-to-end tests (fake Baileys socket, mock gateway)
npm run check     # syntax check of every file + control script
```

The tests never contact WhatsApp or the real gateway. `test/helpers/fake-baileys.js`
fakes the socket and `test/helpers/mock-gateway.js` is a loopback mock of the
Grok Bot gateway API.

Layout:

```
src/main.js                    bridge entry point
src/pair.js                    pairing CLI (code or QR)
src/bridge.js                  WhatsApp bridge core (turns, delivery, approvals notice)
src/core/                      platform-neutral: chat-policy, loop-guard, dispatcher, routing
src/whatsapp/                  Baileys adapter, normalizer, formatter, pairing, QR, secure fs, status
src/grok-client.js, state.js   reused from the Telegram bridge
scripts/sample-quotes-live.mjs live-agent sample run (fake socket, real gateway; opt-in)
deploy/whatsapp-bridge-control.sh
```

## License

MIT (see [LICENSE](LICENSE)), same as the Telegram bridge. Baileys is a
separate project under its own license.
