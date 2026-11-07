# 16 — Push notifications

**Covers:** Web Push from the Worker, per-device consent, per-member kinds, temporary mute, who gets which push, the payload, delivery and failure handling, the `/notifications` screen.
**Read when:** touching `/notifications`, `src/lib/server/push/`, the `PushTransport` port, the service worker's push handlers, or any write that triggers a push (chat send, new thread, new comment, join request).
**Owns:** `R-NTF-*`, `AC-NTF-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§16.n` is in this file.

---

Owner decision 2026-11-06: push moves out of §D into v1.0, built after the installable app (§3.4) and before the
production deploy. Each member picks which kinds reach them and can mute everything for a while; each device opts in
on its own.

## 16.1 Sending

- **R-NTF-01** **Standard Web Push, no sender service.** The Worker sends Web Push itself: VAPID (RFC 8292, ES256 JWT,
  `sub` = the site's `https://` origin, no email) and `aes128gcm` payload encryption (RFC 8291), written on WebCrypto
  in `src/lib/server/push/` (no new dependency, runs the same under Node for `dev:offline`). The key pair is made by
  `setup` (R-OPS-04 step 5): the private key is the Worker secret `VAPID_PRIVATE_KEY`, the public key the var
  `VAPID_PUBLIC_KEY`. Without both, push is *unavailable*: nothing is sent, `/notifications` says so, and a production
  build logs one `config` warning without any value. No third-party script, SDK or relay is involved (R-AUTH-24);
  the only parties that see a push are the browser vendor's push service (encrypted payload, size, timing) and the
  device.
- **R-NTF-02** **Endpoint allow-list.** A subscription endpoint is a URL the Worker will fetch, so it is checked when
  stored and again before each send: `https:` only, no port, no credentials, no IP literal, and a host equal to or
  under one of `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `push.apple.com`, `notify.windows.com`
  (Level B `push.endpointHosts`, R-UI-02). Anything else is `400 invalid`. The `p256dh` key must be a 65-byte P-256
  point and `auth` 16 bytes. Endpoints and keys never appear in logs, audit rows, exports or API responses (R-AUTH-23).
- **R-NTF-03** **Payload, like a chat app** (owner decision 2026-11-06). The encrypted payload is JSON
  `{ kind, title, body, url, tag }`, rendered on the server in the subscription's stored `locale` (labels from the
  dictionaries, R-UI-10). Member text is reduced to plain text (Markdown, links and line breaks stripped) and cut at a
  word boundary to 120 characters with "…"; the whole payload stays under 1 KB. Per kind:
  - `chat`: title the sender's display name, body the message; `url` `/chat`, `tag` `chat`.
  - `thread`: title "<name> · New discussion", body the thread title; `url` `/discussions/<id>`, `tag` `thread-<id>`.
  - `reply`: title "<name> · <thread title cut to 40>", body the comment; `url` `/discussions/<postId>`, `tag`
    `reply-<postId>`, so a thread's replies stack into one notification.
  - `join` (admins): title "Join request", body "<requested name> wants to join"; `url` `/admin#join`, `tag` `join`.
  - `summary` (R-NTF-13): title the site name, body the counts, e.g. "23 chat messages · 2 new discussions · 5
    replies" (each capped at "99+"); `url` `/`, `tag` `summary`.
  The name is the display name every member already sees; never an email, contact field or `preferred_name` of a
  member whose deletion is pending (R-PROF-13). The payload is end-to-end encrypted to the device, so the push service
  can't read it; what the lock screen shows is the phone's preview setting, which `docs/PRIVACY.md` and
  `/notifications` point to. A message deleted after its push can't be recalled from a device that already showed it.
  Request headers: `TTL` 3,600 s for `chat`, 86,400 s otherwise; `Urgency: normal` (`low` for `summary`); `Topic` = the
  tag (≤ 32 URL-safe base64 characters) so the push service keeps only the newest pending one per tag.
- **R-NTF-04** **After commit, never before.** A push is sent only for data D1 committed (INV-8), after the response or
  the chat ack/broadcast, through `waitUntil` (Worker) or after the broadcast (ChatRoom); a push failure never fails or
  delays the write. Nothing is queued for later: a push that can't be sent now is dropped, and a muted member's pushes
  are dropped, not held.
- **R-NTF-05** **Fan-out within Workers Free limits.** An invocation may make at most 50 external subrequests (Workers
  Free, checked 2026-11-06; re-check at build like AC-BUD-01). `PushTransport.send(deliveries)` (§11.3) is the port:
  the Cloudflare adapter splits the deliveries into batches of at most 40 and hands each batch to the named
  entrypoint `PushDelivery` of the same Worker through a service binding (`PUSH`, an RPC call, no HTTP route and no
  Access surface), so each batch runs in its own invocation; at most 7 batches per event (≤ 280 deliveries, R-NTF-08
  caps devices so 50 members fit). All batches leave at once, highest priority first (the event's direct audience:
  for `reply` the thread's author, then other followers; for `join` admins), with no delay between them: the limit
  counts subrequests per invocation, not per second, so a delay would not raise it, and a Worker can't wait between
  invocations without a timer (R-BUD-02, R-CHAT-07). The port carries the plaintext payload, the subscription keys
  and the headers: RFC 8291 encryption runs inside `PushDelivery`, so each batch of 40 pays its own CPU against Workers
  Free's 10 ms per invocation, and the triggering request or Durable Object invocation only builds the deliveries.
  The VAPID key is imported once per event and its JWT signed once per push-service origin. An event's item pushes
  and its due quiet-mode summaries (R-NTF-13) leave in one `send`, items first; a summary is claimed only while the
  event holds fewer than 280 deliveries, so one that cannot leave stays due. A batch whose RPC fails is logged by
  error class only and loses only its own results; the other batches' statuses still count (R-NTF-06). A production
  build without the `PUSH` binding sends nothing and logs one `config` line, as for missing VAPID keys (R-NTF-01);
  there is no in-invocation fallback. The local adapter sends in-process. A test adapter records
  deliveries.
- **R-NTF-06** **Failures.** Per delivery: `201`/`2xx` writes nothing; `404` or `410` deletes the subscription; `400`,
  `403` (VAPID mismatch) and `413` are logged by status only and delete the subscription after the 5th consecutive
  failure; `429`, `5xx` and network errors add one to `failure_count`, and the 5th consecutive failure deletes the row.
  A success after failures resets `failure_count` to 0 (the only success that writes). No retries within an event.

## 16.2 Who gets what

- **R-NTF-07** **Kinds** (`notification_prefs.kinds_json`, per member, applies to every device): `chat`, `thread`,
  `reply`, and for admins `join`. All on by default (the row is created on first save with these defaults). A
  recipient is always an `active` member other than the actor, with the kind on, not muted (R-NTF-09), with at least
  one subscription, on a site that is `unlocked` with the kind's feature on (chat, discussions, `join`) and the
  `notifications` setting on (R-UI-01):
  - `chat`: on every committed chat message, the members the broadcast did **not** reach (no authorized open socket,
    R-CHAT-16), at most one chat push per member per `push.chatCoalesceSeconds` (Level B, default 60), carrying the
    newest message; the device merges them (R-NTF-12). Selection is one conditional `UPDATE notification_prefs SET
    last_chat_push_at = :now, unseen_pushes = unseen_pushes + 1 … WHERE last_chat_push_at < :now - :window AND …
    RETURNING user_id`, so concurrent sends can't double-push and a write happens only for a push actually sent.
    Reads at most 50 prefs rows per message. Every statement on the push path binds at most 100 parameters (D1's
    cap, R-CHAT-16): there is no bulk insert of prefs rows (`POST /subscriptions` creates the member's row), and the
    `NOT IN` exclude lists stay under it.
  - `thread`: a new thread, to every recipient.
  - `reply`: a new comment, to the members who follow the thread (`thread_followers`): its author and everyone who
    commented on it, recorded with `INSERT OR IGNORE` in the same batch as the post or comment. Deleting a comment
    doesn't unfollow. Nothing on edits, pins, locks or deletions.
  - `join`: a stored join request (R-AUTH-27), to admins only.
- **R-NTF-08** **Devices.** A member has at most 5 subscriptions; a 6th replaces their oldest. A `POST` of an endpoint
  already stored moves it to the current member and refreshes its keys and locale (the same device, a different
  member signed in). A suspended member gets nothing (recipients are `active` only); completing a deletion request
  (R-PROF-11) deletes the member's subscriptions, prefs and follower rows.
- **R-NTF-09** **Mute.** `notification_prefs.mute_until` (epoch ms, `NULL` = not muted) stops every kind on every
  device until it passes; it ends on its own with no job. Choices: 1 hour, 8 hours, until morning (the next 07:00 in
  the viewer's time zone: the `tz` cookie, else the site default, R-UI-11) and 1 week; the server computes the instant
  from the choice. *Unmute* sets `NULL` at once.

- **R-NTF-13** **Quiet mode for members who don't open the app.** Every push except `join` adds one to
  `notification_prefs.unseen_pushes`. When it reaches `push.quietAfter` (Level B, default 10) the member is *quiet*:
  item pushes stop, and instead the next event that would have pushed them sends one `summary` (R-NTF-03) if the last
  push was at least the summary interval ago, else nothing. The interval starts at `push.summaryHours` (default 6) and
  doubles with each summary sent since the member was last seen (6 → 12 → 24 h, then daily). Counts are read at
  summary time, only for the member's kinds that are on, since `quiet_since` (replies: only comments on threads the
  member follows), each with `LIMIT 100` on an indexed
  `created_at`. Opening the app (the first page load or chat socket of the member while `unseen_pushes > 0`; the
  membership read joins the prefs row, so this is a write only then) resets `unseen_pushes`, `quiet_since` and the
  summary count, and normal pushes resume. `join` is never quieted. `/notifications` shows "Paused: you'll get a summary
  now and then until you open the app" while quiet. No job runs for this: summaries ride on events (R-BUD-02).
  The counters (`unseen_pushes`, `last_chat_push_at`) and a summary claim are written before sending, so a push lost
  to a failed delivery batch or a VAPID signing failure still counts toward quiet mode and the chat coalesce window,
  and a lost summary waits for the next interval.

## 16.3 Device and screen

- **R-NTF-10** **Consent per device, from a tap.** `/notifications` (linked from `/profile` and the member menu) asks for
  permission only from the *Turn on for this device* button, never on load. On grant it calls
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` and `POST`s the subscription with the
  current locale and a device label derived from the user agent (e.g. "Chrome on Android"; never the raw UA). On iOS
  and iPadOS Web Push exists only in the Home Screen app (16.4+): outside it (R-NAV-09 kind `ios` or `in-app`) the
  button is replaced by a link to `/install`. Denied permission shows how to re-allow in the browser settings.
  Unsupported browsers see a plain notice.
- **R-NTF-11** **The screen** shows: this device's state (on, off, blocked, unsupported, unavailable), the kind toggles
  (`join` only for admins), the mute choices or *Muted until <time> · Unmute*, and the member's devices (label, added
  date, *Remove*). *Turn off for this device* unsubscribes in the browser and deletes the row. On load, when
  permission is granted and the browser has a subscription the server doesn't list (after a restore, R-BAK-06, or a
  missed change), it is posted again once; nothing repeats while idle (AC-BUD-03).
- **R-NTF-14** **Asked in the installed app.** Home shows a dismissible card, rendered on the client after hydration,
  only in the installed app (R-NAV-09 kind `installed`, where Web Push works on every platform including iOS) when the
  browser supports push, permission on this device is still `default`, the site has VAPID keys and `notifications` is
  on, and the card was not dismissed in the last 30 days (`localStorage` `classhub:push-card-dismissed`). Its *Turn on
  notifications* button runs the R-NTF-10 flow from that tap; on success the card says so and links to
  `/notifications`, a refused prompt hides it. `/install` adds a line after its steps: once installed, open the app and
  turn on notifications. It never shows with the install card (R-NAV-11), which is never shown for `installed`.
- **R-NTF-12** **Service worker handlers** (amending R-NAV-08): `push` shows exactly one notification from the payload
  (title, body, tag, `renotify` true, the 192 px icon); for `chat` and `reply` tags it first reads the shown
  notification with the same tag (`getNotifications`) and merges, like a chat app: title "Class chat · 3 new
  messages" (or the thread title for replies) and the last three lines as "Name: text", counted on the device only; with a generic bilingual fallback when the payload doesn't
  parse, because iOS revokes a subscription whose push shows nothing; `notificationclick` focuses an open window of
  the app and navigates it, else opens one, and only to a same-origin path (anything else opens `/`);
  `pushsubscriptionchange` re-subscribes and posts the new subscription (best effort: it fails without a live Access
  session, and R-NTF-11 heals it on the next visit). The worker still caches nothing beyond R-NAV-08 and adds no sync
  or periodic handlers.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-NTF-01 | The encryption matches RFC 8291's worked example byte for byte, and a VAPID header verifies against the public key with `aud` = the endpoint origin, `exp` ≤ 24 h and `sub` = the site origin | R-NTF-01 | unit |
| AC-NTF-02 | Endpoints over `http:`, with a port, credentials, an IP literal, a look-alike host (`fcm.googleapis.com.evil.test`) or an unlisted host are refused with `invalid`, as are malformed keys; no log line, response or export carries an endpoint or key | R-NTF-02 | unit + integration (log spy) |
| AC-NTF-03 | Each kind's payload, in vi and en, carries the sender's display name and the stripped text cut at 120 characters on a word boundary (Markdown, links and a 4 KB message as input), never an email, contact field or a pending-deletion member's `preferred_name`, and stays under 1 KB | R-NTF-03 | unit |
| AC-NTF-04 | Chat: the sender, members with an authorized open socket, muted members, members with `chat` off, suspended members and members inside the 60-s coalesce window get nothing; two concurrent messages push each other member at most once; after the window the next message pushes again | R-NTF-07 | integration (recording transport, fake clock) |
| AC-NTF-05 | A new thread pushes every recipient but the author; a comment pushes the thread's author and earlier commenters but not the commenter or non-followers; a join request pushes admins with `join` on and no member | R-NTF-07 | integration (also: no push-path statement binds more than 100 parameters with 50 subscribed members) |
| AC-NTF-06 | The mute choices give the right instants (morning across midnight and in two time zones); pushes stop while muted and resume after `mute_until` passes with no write; *Unmute* resumes at once | R-NTF-09 | unit + integration (fake clock) |
| AC-NTF-07 | `404`/`410` delete the subscription; five consecutive `429`/`5xx`/network failures delete it; a success in between resets the count; a failing push never fails the write or the chat ack | R-NTF-04, 06 | integration (scripted transport) |
| AC-NTF-08 | 120 deliveries reach `PushDelivery` as 3 batches of ≤ 40, and no batch makes more than 40 fetches | R-NTF-05 | unit (stubbed binding); integration (one event's items and summaries in at most 7 `deliver` calls, a throwing batch loses only its own results) |
| AC-NTF-09 | A 6th subscription replaces the oldest; re-posting an endpoint under another member moves it; a member can't list or delete another member's subscription (`not_found`); completing a deletion removes subscriptions, prefs and follower rows | R-NTF-08 | integration |
| AC-NTF-10 | With `notifications` off, without VAPID keys, with the site locked or with the kind's feature off, nothing is sent; the API answers `feature_disabled` when the setting is off; subscriptions are kept | R-NTF-01, 07 | integration |
| AC-NTF-11 | The `push` handler shows one notification from a payload and the fallback for garbage; three chat pushes merge into one "3 new messages" notification with the last three lines; a click on a cross-origin `url` opens `/` | R-NTF-12 | unit (service worker handlers) |
| AC-NTF-12 | `/notifications` at 390 px: the button asks permission only on tap (stubbed `pushManager`), kinds and mute persist across reloads, *Remove* drops a device, an iPhone UA outside standalone shows the `/install` link, an unlisted browser subscription is posted again once | R-NTF-10, 11 | e2e |
| AC-NTF-13 | On the live site: the installed Android app and the installed iPhone app each get a chat push while closed and none while `/chat` is open; a 1-hour mute holds; tapping a reply push opens the thread | R-NTF-01, 07, 09, 12 | manual (plan 4f/4g checklist) |
| AC-NTF-14 | After 10 unseen pushes a member gets no item push; the next event sends one `summary` with the right capped counts for their kinds only; the next comes no sooner than 6 h, then 12 h, then 24 h; `join` still arrives; one page load resets it and item pushes resume; an active member's page loads write nothing | R-NTF-13 | integration (fake clock, row counter; a summary beyond the event ceiling stays unclaimed; the reply count covers followed threads only) |
| AC-NTF-15 | The home push card shows only for an installed app with permission `default`, supported push and no dismissal in the last 30 days; never in a browser tab | R-NTF-14 | unit (`pushCardVisible`) |
