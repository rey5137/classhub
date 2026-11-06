# Class Hub — Implementation Plan

- **Covers:** how the spec (`docs/spec/SPEC.md` and its child files) gets built: phase order and gates, decisions locked in during planning, gaps filled with defaults, the test suites, and each phase's slices. Nothing here is a source of truth about what the site does.
- **Read when:** building, slicing or sequencing a phase. For what a behaviour *is*, read the spec.
- **Read only:** §Phases, §1–2, and your own phase in §4, whose **Read** list names the spec sections it needs; §3 when the slice adds a test suite or a script.

Each phase is built, stopped and handed back with a Manual Verification Checklist, and the next phase starts only after
explicit approval ("Phase N verified, proceed to Phase N+1"). Each slice's **Covers** line lists the acceptance
criteria (`AC-*`, spec §0) it proves.

* **Repo:** `classhub` (local at `~/projects/github/classhub`; GitHub remote created only with the owner's go), MIT
* **Deployment target:** the owner's **second Cloudflare account** (not the account other projects use); every remote command through `scripts/cf.mjs` (spec §2.6, INV-9)
* **Worker:** `classhub` on `classhub.<account-subdomain>.workers.dev`; no custom domain in v1.0 unless the owner adds one, or the 1d WebSocket-through-Access probe fails and a custom domain becomes the fallback (spec R-OPS-16)
* **Resources:** D1 `classhub-db`, R2 `classhub-media`, Durable Object class `ChatRoom` (binding `CHAT_ROOM`)
* **Identity:** Zero Trust Free organization in the second account, Google and One-time PIN login methods, one self-hosted Access application for the Worker hostname (covering the custom hostname too, one AUD, if a custom domain is added)
* **Stack:** SvelteKit 2 + Svelte 5 + TypeScript strict, Drizzle, Zod, Vitest, `@cloudflare/vitest-pool-workers`, Playwright
* **Locales:** `vi` (default), `en`

---

## Phases

This plan holds what to build, never progress: no status column or checkboxes. Progress is read from git: phase N is
in progress while branch `pN-<name>` exists, each slice is one commit on it, and a phase is verified once its last
commit is on `main` and tagged `pN-verified`. The gate approval goes in that tag's message.

| Phase | Slices | Gate needs |
|---|---|---|
| 0 — Foundation | 0a · 0b · 0c | clean clone → `npm run verify` green, local demo, Worker dry-run build exporting `ChatRoom` |
| 1 — Identity and members | 1a · 1b · 1c · 1d | allowed vs denied Gmail in the second account; visibility tests |
| 2 — Memories | 2a · 2b · 2c | upload / view / delete, quota stop, private media |
| 3 — Home and discussions | 3a · 3b | pinned threads, pagination over thousands, moderation |
| 4 — Live chat | 4a · 4b · 4c · 4d · 4e · 4f · 4g | two live sessions in production, persistence, verified-archive pruning, push on installed phones |
| 5 — Portability | 5a · 5b · 5c | an independent restore of the production site, `restore --target local` opening it offline |
| 6 — Open-source release | 6a · 6b | a second person deploys from a clean clone; v1.0.0 tag |

**Release gate (v1.0):** a fresh install, a non-member denial test, a working WebSocket through Access and a
successful independent restore. Deploying is not enough.

---

## 1. Decisions locked in during planning

* **Second Cloudflare account (owner, 2026-11-05).** The global `wrangler login` on the owner's machine belongs to
  another account and stays untouched. `.env.cloudflare` (gitignored) holds the second account's id and an
  account-scoped API token; `scripts/cf.mjs` is the only way remote `wrangler` runs (spec R-PLAT-12). Agents and
  scripts never run `wrangler login`.
* **Tests over custom checkers.** Vitest suites (unit, contract, integration, security), Playwright for e2e, all
  behind `npm run verify` (spec R-PLAT-11). A test proving an AC names it in its title (`AC-AUTH-05 …`), so
  `npm run ac:report` can list which ACs have tests.
* **Contract suites first.** Each port's contract suite is written with its first adapter and run against the second
  as soon as it exists (spec R-PLAT-06), so `restore --target local` (5b) needs adapters, not new ports. The production
  Node server and OIDC adapter are deferred past v1.0 (spec §D).
* **Worker entry wraps SvelteKit.** `src/worker.ts` imports the `adapter-cloudflare` output and re-exports
  `ChatRoom`; 0a proves the build and a `wrangler deploy --dry-run` before anything depends on it (spec §15 risk).
* **Uploads proxy through the Worker** with the native R2 binding; presigned URLs are deferred (spec §D).
* **Pruning and full backups are CLI-only** (D10): no Cron Trigger in v1.0; housekeeping piggy-backs on traffic at
  most hourly (spec R-MEM-11, R-BUD-02).
* **Deploys, Cloudflare and Google changes run only when the owner asks**, each a named step in 1d, 2c, 4b, 5b, 6b.

## 2. Gaps the spec leaves silent, filled with defaults

* **Markdown stack:** a hand-written parser limited to the R-BRD-03 subset (no `marked`), then a string allow-list
  sanitizer that runs without a DOM (`sanitize-html` is too heavy for the Worker; pick in 3a, measured against the
  10 ms CPU budget on a 10,000-character post).
* **JWT library:** `jose` (Workers-compatible, no Node built-ins).
* **UUIDv7:** a small local generator in `src/lib/server/ids.ts` (no dependency), tested for ordering.
* **Image encoding:** browser `OffscreenCanvas.convertToBlob({ type: 'image/webp' })`, falling back to `<canvas>`
  and JPEG on Safari versions without WebP encoding (spec R-MEM-02).
* **Demo images:** generated at seed time as simple SVG-to-WebP gradients with captions, so no photo of a real person
  is ever in the repo.
* **Rate-limit storage outside the DO:** the `rate_events` table, pruned on write (spec R-AUTH-21); the chat limiter
  lives in the DO's memory.
* **Hourly housekeeping trigger:** the first authenticated request after the hour, run in `waitUntil`.
* **Release check:** `preflight` fetches `api.github.com/repos/<owner>/classhub/releases/latest` on the admin's machine
  and prints a notice; the Worker and browser never call GitHub and the CSP has no extra `connect-src` (spec R-OPS-13).
* **Backups are encrypted, always:** `age` is a prerequisite and `backup` refuses without a recipient (spec R-BAK-05);
  one S3 client, `scripts/lib/s3.mjs`, no `rclone` (R-BAK-17).
* **Screenshot sizes:** 390 × 844 and 1280 × 800.

## 3. Test suites and scripts

* **`tests/unit/`** — pure functions: projection (AC-PROF-01), validation, normalizers, Markdown, permissions,
  token buckets, manifest checks, `cf.mjs` guards.
* **`tests/contract/<port>.ts`** — shared suites run by `tests/contract/run-local.test.ts` (local adapters) and
  `tests/contract/run-workers.test.ts` (Workers pool with D1, R2, DO).
* **`tests/integration/`** — routes through `app.server` with seeded data, on the Workers pool, with a local JWKS and
  signed test JWTs (never a bypass in app code).
* **`tests/security/`** — route sweep from the route manifest (AC-API-01), forged identity (AC-AUTH-01, 02), uniform
  denial (AC-AUTH-05), cross-origin (AC-AUTH-07), DO context (AC-CHAT-04), bundle scan (AC-PLAT-05, 09), import rule
  (AC-PLAT-02), log capture (AC-AUTH-12), remote-wrangler, `rclone` and R2/API-host grep (AC-PLAT-07).
* **`tests/e2e/`** — Playwright on `dev:offline` and `dev`, Chromium and WebKit, 390 and 1280 px, axe on every route.
* **Scripts** (`scripts/`): `cf.mjs`, `setup.mjs`, `preflight.mjs`, `unlock.mjs`, `invite.mjs`, `backup.mjs`,
  `verify-backup.mjs`, `restore.mjs`, `export-chat.mjs`, `prune-chat.mjs`, `housekeeping.mjs`, `screenshots.mjs`,
  `ac-report.mjs`, and `lib/s3.mjs` (the only S3 client, 2c); each with unit tests against a fake `wrangler`/API.

---

## 4. Phases

### Phase 0 — Foundation

**Read:** spec §1, §2, §5, §10.

#### Slice 0a — skeleton and Worker build
- **Covers:** AC-PLAT-01 (partly), AC-PLAT-04, AC-PLAT-06, AC-PLAT-07.
- SvelteKit + TS strict, Svelte 5, `adapter-cloudflare` as the only build target (offline dev through `CLASSHUB_OFFLINE`, Node deferred past v1.0); ESLint,
  Prettier, `svelte-check`, Vitest, Playwright; `.nvmrc`, `.gitignore` per R-PLAT-09.
- `src/worker.ts` wrapping the SvelteKit output and exporting a stub `ChatRoom` (SQLite-backed); `wrangler.jsonc.example`;
  `/health`.
- `scripts/cf.mjs` with its guards and unit tests against a fake `wrangler`; `.env.cloudflare.example`.
- `npm run verify` and `.github/workflows/ci.yml`.
- **Done when:** `npm run verify` is green; `node scripts/cf.mjs deploy --dry-run` builds a bundle that exports
  `ChatRoom`.

**Manual Verification Checklist (0a)**
1. `npm ci && npm run verify` on a clean clone passes.
2. `node scripts/cf.mjs whoami` with no `.env.cloudflare` refuses with a clear message.
3. With the second account's values in `.env.cloudflare`, `node scripts/cf.mjs whoami` names that account, and plain `npx wrangler whoami` still shows your other account.
4. `npm run build` then `node scripts/cf.mjs deploy --dry-run` lists `ChatRoom` among the exports.

#### Slice 0b — schema, ports and local adapters
- **Covers:** AC-DB-01, AC-DB-02, AC-PLAT-02, AC-PLAT-03 (Database, ObjectStorage on local + Workers pool).
- Drizzle schema for every §5.2 table, `migrations/0001_init.sql`, `schema_meta`; `test:migrations`.
- Ports in `src/lib/server/ports/`; D1 and `better-sqlite3` Database adapters; R2 and filesystem ObjectStorage
  adapters; `context.ts`; the contract suites for both ports; the import-boundary lint rule.
- `npm run dev:offline` on local adapters with the dev identity (localhost only); `db:seed:demo` with synthetic members.
- **Done when:** both contract suites pass on both adapters; the seed runs on both.

**Manual Verification Checklist (0b)**
1. `npm run db:seed:demo && npm run dev:offline`; `/health` answers, and `data/dev.sqlite` holds the demo members.
2. `npm test -- contract` shows each suite passing twice (local, workers).
3. Importing `D1Database` from a service file makes `npm run lint` fail.

#### Slice 0c — themes, i18n and the shell
- **Covers:** AC-UI-04, AC-UI-05, AC-UI-06, AC-UI-07, AC-NAV-01 (shell routes as placeholders).
- **Design:** follow `docs/design/01-DIRECTION.md` (owner-chosen direction): bundled Be Vietnam Pro and Patrick
  Hand, the fixed type scale, the three themes' token tables, the shell with the red spine stripe, and the `Row`,
  `Rail` and `Tile` primitives with focus-grow (§5–6). The prototype in `.impeccable/mocks/proto/` is the reference.
- `tokens.css`, `minimal`, `yearbook`, `night`; `registry.ts`; `site.config.ts` and the validated config object;
  server-side `data-theme`/`data-mode`.
- The primitives of R-UI-09; `AppShell` with the mobile tab bar and desktop top bar; placeholder pages for every §3.1
  route; `vi`/`en` dictionaries; the accent-contrast validator; the stylelint token rule.
- `npm run screenshots` producing every route × theme × mode × size into `.screenshots/` (gitignored).
- **Done when:** axe passes on the placeholder routes in every theme × mode; screenshots are produced.

**Manual Verification Checklist (0c, phase gate)**
1. `npm run dev:offline`, open `/` at phone width: tab bar, themed header, *Our Class*.
2. Switch `site.config.ts` theme to each of the three; nothing but the look changes.
3. Look through `npm run screenshots` output: does each theme have the character you want (clean, nostalgic, dark)?
4. Switch the locale to `en` and back; no untranslated key shows.

### Phase 1 — Identity and members

**Read:** spec §3, §4, §6, §11, §12.1–12.5.

#### Slice 1a — Access identity and the request pipeline
- **Covers:** AC-AUTH-01, 02, 03, 05, 07, 08, 12, 15, AC-API-01 (pipeline), AC-API-03, AC-PLAT-09.
- `IdentityProvider` port, Access JWT adapter (`jose`, JWKS cache), dev identity adapter; `hooks.server.ts`:
  identity → membership → `locals.member`, request id, headers (R-AUTH-20), uniform denial, Origin check, body limits,
  log redaction; the error helper (R-API-02); the security test harness with a local JWKS.
- **Done when:** every forged-identity case is denied by the security suite.

#### Slice 1b — invites, membership, setup lock and admin bootstrap
- **Covers:** AC-AUTH-04, 06, 09 (profile, invite limits), 11 (fake API), 14 (match by email and the audited sub change; the "restore re-links" half is 5b's), AC-NAV-02, 03, 05.
- Invite and membership services, `permissions.ts`, the setup lock and `/locked`, `/admin/setup`, `/denied`; admin
  invite UI with seat count; `scripts/invite.mjs` (app list + optional Access policy sync); suspend/reactivate with
  `RealtimeHub.disconnectMember` stubbed until 4a.
- **Done when:** the lock, invite → active and the permission matrix are covered by integration tests.

#### Slice 1c — profiles and the directory
- **Covers:** AC-PROF-01, 02, 03, 04, 05, 06, 07, 08.
- `projectProfile`, contact normalizers and allow-list, `/profile`, `/members`, `/members/[id]`, own export,
  clear-profile, deletion request and admin completion. Avatars wait for 2b (placeholder initials).
- **Done when:** the projection table test and the email-leak sweep pass.

#### Slice 1d — first deploy to the second account
- **Covers:** AC-AUTH-10, AC-AUTH-11 (live), AC-OPS-01, 02 (first pass), 03, 04, 05, AC-PLAT-08, AC-BUD-01.
- `scripts/setup.mjs`, `preflight.mjs`, `unlock.mjs`, `lock`, `smoke:test`; `docs/DEPLOY_CLOUDFLARE.md` and
  `docs/GOOGLE_ACCESS.md` (first version); re-check §14 figures and correct the spec.
- **WebSocket-through-Access probe (spec R-OPS-16, §15):** deploy the stub `ChatRoom` as a WebSocket echo behind a
  temporary route, put the self-hosted Access application on the `workers.dev` hostname, and prove a socket (`101`,
  an echoed message) from a signed-in browser, and a refusal without a session. Record the result. **If it fails
  (403 or no upgrade):** stop and bring the owner the fallback decision, a custom domain with one Access application
  covering both hostnames and one AUD (R-OPS-16); nothing in 1a-1c depends on the outcome, but 4a/4b do.
- **Owner steps (confirm each):** activate R2 billing in the second account; create the account-scoped API token;
  run `setup` and `deploy`; create the Zero Trust organization, the Google OAuth client and the Access application;
  add your own and one test classmate's Gmail, and enable One-time PIN (`age` is not needed until 2c).
- **Done when:** preflight passes against the live deployment and the site unlocks.

**Manual Verification Checklist (1d, phase gate)**
1. `npm run setup` twice: the second run reports existing resources and creates nothing.
2. Before configuring Access, open the `workers.dev` URL: `/locked`, no data.
3. Sign in with the bootstrap admin Gmail: `/admin/setup` checklist only.
4. `npm run preflight` lists every check passing; `npm run unlock` succeeds.
5. Invite a second Gmail with `npm run invite -- add <email>`; it reaches the site. A third, uninvited Gmail is stopped at the Access screen.
6. Remove the second Gmail from the app list only (leave it in Access): it sees `/denied`.
7. Invite a non-Gmail address; it signs in with the One-time PIN and reaches the site.
8. In the Cloudflare dashboard of the **second** account: the Worker, D1, bucket and Access app are there; your other account shows none of them.
9. Set a phone to *members* on one account and confirm the other sees it, then back to *private* and it's gone.
10. The echo probe: a WebSocket through Access on `workers.dev` returns `101` and echoes; without a session it is refused. If not, the custom-domain decision is made before Phase 2.

### Phase 2 — Memories

**Read:** spec §7, §11.2–11.3, R-DB-07, R-DB-08.

#### Slice 2a — reservations, streaming upload and the quota ledger
- **Covers:** AC-MEM-04, 05, 06, 09, 10, AC-API-05.
- Reservation, upload and complete routes; signature and hash validation while streaming; conditional reservation
  update; housekeeping and reconcile; media streaming route with headers and ETag.
- **Done when:** the integration suite on the R2 pool proves every refusal leaves no object.

#### Slice 2b — browser optimization, upload UI and avatars
- **Covers:** AC-MEM-01, 02, AC-PROF (avatar in profile).
- The encoder worker (`OffscreenCanvas`, fallbacks, size steps), the upload sheet with preview and progress,
  caption/album/year fields, avatar crop and upload; notices about originals.
- **Done when:** e2e uploads a fixture 12 MP JPEG in Chromium and WebKit and the stored bytes carry no EXIF.

#### Slice 2c — gallery, albums, photo detail and admin usage
- **Covers:** AC-MEM-03, 07, 08, AC-UI-02 (memories routes), AC-BAK-02, 03, 09, 11 (minimal), AC-OPS-06, AC-DB-05,
  AC-PLAT-07 (extended).
- **First, before any real photo is uploaded:** a minimal `backup` and `verify-backup` (spec R-BAK-02-05, 09, 17):
  D1 SQL export plus a full object copy through `scripts/lib/s3.mjs`, manifest and checksums, `age` encryption
  (refuses without `age` and a recipient), `backup_runs`, checksum/SQL-parse/object-hash verification, and the
  `db:migrate:remote` check for a verified backup newer than the last deploy. **The INV-7 destructive-migration gate
  exists from this slice**; 5a extends it. AC-PLAT-07's grep is extended in the same slice to `rclone`,
  `api.cloudflare.com` and `r2.cloudflarestorage.com`. Owner step: install `age`, create a key pair, confirm one
  verified encrypted backup of the live site.
- `/memories` grid with album/year filters and paging, `/memories/[id]`, delete, album create/edit, `/admin` usage
  card (R-MEM-18), the 8 GB banner; deploy to the second account (owner confirms).
- **Done when:** upload → view → delete works on the live site from a phone.

**Manual Verification Checklist (2c, phase gate)**
0. Before uploading real photos: `npm run backup` ends *verified* and writes an encrypted `.tar.age` only; `npm run verify-backup -- <file>` passes; a destructive migration is refused without it.
1. On your phone, upload three photos (one HEIC if your phone makes them), with a caption and an album.
2. They appear on `/memories`; filters by album and year work; detail shows the caption and you as uploader.
3. Copy a photo's address into a private window (no Access cookie): Access login, not the photo.
4. Download a stored photo from the detail page and check its properties: no location.
5. Delete a photo: gone from the wall and the photo count drops; stored bytes drop after the grace period (R-MEM-20).
6. With `mediaStopBytes` lowered in a local `site.config.ts` to just above current usage, an upload is refused with *uploads are paused*.

### Phase 3 — Home and discussions

**Read:** spec §8, R-DB-06–08, §10.3.

#### Slice 3a — Markdown, posts and comments
- **Covers:** AC-BRD-01, 02, 03, 04, 06, AC-DB-03, 04.
- Markdown renderer + sanitizer (CPU measured), photo references, post and comment services and routes, counters,
  pin/lock/moderation with audit events.

#### Slice 3b — board and home screens, info pages, site settings
- **Covers:** AC-BRD-05, AC-UI-01, AC-UI-02 (board, home, admin), AC-NAV-04.
- `/discussions`, `/discussions/[id]`, `/`, `/info/[slug]`, admin info pages and site settings (Level A, §10.1:
  name, years, welcome, banner, logo, favicon, theme, mode, accent, density, language, feature toggles).
- **Done when:** e2e covers the board over 5,000 seeded threads and a theme switch from `/admin`.

**Manual Verification Checklist (3b, phase gate)**
1. Create a thread with bold, a list and a link; a second account comments; the thread moves to the top.
2. As admin, pin and lock it; the second account can no longer comment.
3. Paste `<script>alert(1)</script>` and `[x](javascript:alert(1))` into a post: shown as text, no link.
4. Change the theme, accent and welcome message in `/admin`; Home changes, content doesn't.
5. Turn discussions off and on again; the threads come back.

### Phase 4 — Live chat

**Read:** spec §9, R-AUTH-03, R-AUTH-17, R-PLAT-02.

#### Slice 4a — ChatRoom, handshake and persistence
- **Covers:** AC-CHAT-02, 03, 04, 05, 06, 11, 12, 13, 14, AC-PLAT-03 (RealtimeHub on both adapters).
- The signed context, WS route, ChatRoom with hibernation, conditional idempotent insert, ack/broadcast, presence,
  `disconnectMember`; local `ws` hub adapter; history routes.
- **Remove the 1d WebSocket probe** (R-OPS-16): `src/routes/__probe/ws/`, `adapters/cloudflare/ws-probe.ts`,
  `AppContext.wsProbe`, the `ChatRoom` echo (`PROBE_PATH`), `tests/integration/ws-probe.test.ts` and any `WS_PROBE`
  var left in `wrangler.jsonc`; the 1d result stays recorded in `docs/DEPLOY_CLOUDFLARE.md`.

#### Slice 4b — chat UI and the production WebSocket
- **Covers:** AC-CHAT-01, 07, 08, 15, AC-BUD-03.
- `/chat` with history paging, unread marker, reconnect, not-sent retry, online count, deletion; deploy (owner
  confirms) and test through Access on desktop and iOS Safari.

#### Slice 4c — retention, archive and pruning
- **Covers:** AC-CHAT-09, 10, 16 (the `export-chat` half; the `restore --chat` half is 5b's, with `restore.mjs`), 17.
- `export-chat` (age-encrypted, never overwrites), `prune-chat` (chunked, resumable), `chat_archives` rows, both
  taking the backup lock; a local target for both (the checklist's item 4); the over-retention admin banner.
- Model: Opus · high (INV-7: archive before prune).

#### Slice 4d — join requests
- **Covers:** AC-AUTH-16, 17, 18, 19.
- Public `/join` form behind an Access Bypass application (like `/health`), Turnstile, `join_requests` (additive
  migration), the `join` site setting (off by default) and Level B `join.maxPending`, the admin queue card on `/admin`
  (approve = the invite path, R-AUTH-08/18; reject), housekeeping deletes requests older than 30 days, the
  `docs/PRIVACY.md` section, the Bypass app and Turnstile keys in `docs/DEPLOY_CLOUDFLARE.md`.
- Model: Opus · high (identity and the Access boundary).

#### Slice 4e — installable app and install guide
- **Covers:** AC-NAV-06, 07, 08, 09, 10.
- Public `/manifest.webmanifest` route and `/icons/` (an Access Bypass application like `/health`, added to the
  deploy step and `docs/DEPLOY_CLOUDFLARE.md`; the pipeline skips identity for exactly these paths), the default icon set in `static/icons/` drawn from `favicon.svg`, the head links and
  meta in `app.html`/the root layout, `src/service-worker.ts` with `static/offline.html`, `src/lib/install/detect.ts`,
  the `/install` page, the Home card and the `/profile` link, both dictionaries, the Level B `shortName`, the
  icon-replacing step in the customization docs. No D1 change, no new dependency, CSP unchanged (`manifest-src` and
  `worker-src` fall back to `'self'`). Screens: `/install` and Home with the card.
- Model: Sonnet · medium.

#### Slice 4f — push core and chat pushes
- **Covers:** AC-NTF-01, 02, 03 (chat kind), 04, 06, 07, 08, 10, 11, 12, 14, AC-NTF-13 (chat half).
- Builds after 4e (needs `src/service-worker.ts`). `src/lib/server/push/` (VAPID ES256 JWT and RFC 8291 `aes128gcm`
  on WebCrypto, endpoint allow-list, payload renderer), the `PushTransport` port with the Cloudflare adapter
  (`PushDelivery` named entrypoint in `src/worker.ts`, the `PUSH` self service binding, batches of 40; add the export to
  `check-worker-exports.mjs`), the local and recording adapters; `push_subscriptions` and `notification_prefs`
  (additive migration); the `notifications` site setting and Level B `push.*`; the notifications API and the
  `/notifications` screen with the `/profile` and member-menu links; the service worker's `push`,
  `notificationclick` and `pushsubscriptionchange` handlers; the chat trigger in `src/lib/server/services/chat-room.ts`
  after the broadcast (recipients exclude every member the broadcast reached; conditional coalesce `UPDATE`); quiet
  mode and summaries (R-NTF-13, its reset joined into the membership read); `setup`
  generating the VAPID pair and the binding; `restore` emptying `push_subscriptions`; own export;
  both dictionaries; the `docs/PRIVACY.md` push section (what is stored, what push services see, how to turn it off).
  Screens: `/notifications` (on, off, blocked, muted, iPhone outside the Home Screen app).
- Risk: whether service-binding calls count against the 50 external subrequests on Workers Free is not stated
  clearly in Cloudflare's docs; the batching keeps each batch's fetches ≤ 40 either way, and the 32-invocation cap
  allows the ≤ 7 batches. CPU is the second limit: encryption runs inside `PushDelivery` (one batch of ≤ 40 per
  invocation), the VAPID JWT is signed once per push service per event, and summaries share the event's `send`
  (R-NTF-05). Confirm on the live site at checklist item 8 with all devices subscribed, reading Workers metrics
  "CPU time p99" as well.
- Model: Opus · high (a member-supplied URL the Worker fetches, crypto, privacy of the payload).

#### Slice 4g — discussion and join pushes
- **Covers:** AC-NTF-03 (thread, reply, join kinds), 05, 09, AC-NTF-13 (reply half).
- `thread_followers` (additive migration, backfilled from existing posts and comments in the migration), written with
  `INSERT OR IGNORE` in the post and comment batches; `thread` and `reply` pushes after commit through `waitUntil`;
  the `join` push from 4d's request path, admins only; the device cap, endpoint move and deletion cleanup (R-NTF-08); the kind toggles
  for these kinds on `/notifications`. No new screen beyond the toggles.
- Model: Sonnet · medium.

**Manual Verification Checklist (4c, 4d, 4e, 4f, 4g, phase gate)**
1. Two phones on the live site: messages arrive instantly both ways, the online count is 2.
2. Turn one phone's network off, send from the other, turn it back on: the missed messages appear in order.
3. Suspend the second account from `/admin`: its chat disconnects and it can't send.
4. Locally, with a seed of 31,000 messages: `npm run prune-chat` refuses; `npm run export-chat` then `prune-chat` removes only the archived oldest 1,000.
5. Turn join requests on in `/admin`. In a private window open `/join` and submit a request; approve it on `/admin`;
   that Google account signs in and lands on Home. A second request for the same address shows the same
   confirmation and stores nothing. With the queue full, `/join` shows the closed notice.
6. On the live site, Android Chrome: the Home card's Install button installs the app; it opens standalone with the
   class icon (no Chrome badge), signs in and reaches chat.
7. iPhone Safari: follow `/install` (Share → Add to Home Screen); the app opens standalone, asks to sign in once, then
   reaches chat. Open the site link from Zalo or Messenger: the card shows the open-in-Safari steps and Copy link.
8. Turn push on in both installed apps (Android, iPhone) and in one desktop browser. Close the apps; send a chat
   message from a third member: each device shows the sender's name and the message within a minute; two more
   messages a minute apart merge into one "3 new messages" notification. With `/chat` open on one phone, that phone
   gets no push. Leave one phone unopened through 10 pushes: further messages stop arriving one by one and a summary
   comes instead; opening the app brings normal pushes back.
9. Mute for 1 hour on one phone: no push from a new thread; *Unmute*, start another thread: the push arrives. Comment
   on a thread the other phone's member started: their phone shows the reply push and tapping it opens the thread.

### Phase 5 — Portability

**Read:** spec §13, R-DB-10–12, R-PLAT-06.

#### Slice 5a — backup completion and verify
- **Covers:** AC-BAK-06, 08, 10 (AC-BAK-02, 03, 09, 11 extended from 2c).
- Extends 2c's `backup`/`verify-backup`: NDJSON `portable/` export, live `COUNT(*)` before export and the dump-holds-
  at-least check, the lock shared with `prune-chat`, `--prune-old` retention, encrypted `export-chat` archives, the
  deletion-race fixture (spec R-BAK-16, relying on the purge grace period from 2a/2c), `/admin` backup status, and the
  full INV-7 gate (chat pruning and restores) (AC-OPS-06, AC-DB-05).

#### Slice 5b — restore
- **Covers:** AC-BAK-01, 04, 05, AC-CHAT-16 (the `restore --chat` half, R-CHAT-15).
- `restore --target new|local` (new: refuses non-empty DB or bucket and live ids, restores `setup_state='locked'`;
  same schema version only), integrity checks; `docs/BACKUP_RESTORE.md`, `docs/MIGRATION.md`. The Node server, OIDC
  adapter and `SELF_HOST_NODE.md` are deferred (spec §D).
- `restore.mjs` runs `RESTORE_CLEAR_PUSH_SUBSCRIPTIONS` (`scripts/lib/backup-sql.mjs:13`) so a restored site holds no
  push subscriptions, and 5b's tests prove it (R-BAK-06; R-NTF-11 re-posts them on the next visit).
- **Owner step:** back up the live site and restore it into a new D1 + bucket in the second account, side by side,
  then run `preflight` and `unlock` there.

#### Slice 5c — release-readiness of data paths
- **Covers:** AC-BUD-02, 04, remaining AC-PROF-05/06 production checks.
- Row-read budget test per route, D1-failure degradation, deletion-request handling across backups and archives
  documented in `docs/PRIVACY.md`.

**Manual Verification Checklist (5c, phase gate)**
1. `npm run backup`: it ends with *verified* and `/admin` shows the date.
2. Delete one file from `objects/` in a copy and run `verify-backup` on it: it names the missing image.
3. `npm run restore -- <backup> --target local && npm run dev:offline`: your live photos, threads and chat are there, offline.
4. The side-by-side restore in the second account opens with the same counts.

### Phase 6 — Open-source release

**Read:** spec §1, §12, §14, §15; every child file's acceptance table for the AC sweep.

#### Slice 6a — docs, repo hygiene and security review
- **Covers:** AC-BUD-05, AC-UI-03, AC-OPS-07 (prepared).
- README (what, features, requirements and R2 billing caveat, Quick Start, one screenshot per theme, backup promise),
  CONTRIBUTING completed, CODE_OF_CONDUCT, SECURITY, CHANGELOG, issue templates, `docs/THEMES.md`, `docs/PRIVACY.md`,
  `deploy.yml` (optional, off), `ac:report` showing every AC covered or listed as manual; a full
  security review of identity, media and chat paths; a git history scan for secrets and real data.

#### Slice 6b — clean-clone deployment and v1.0.0
- **Covers:** AC-OPS-02, AC-OPS-07, the release gate.
- A second person (or the owner on a clean machine) follows only the README and guides into a fresh Worker name in the
  second account; fixes every doc gap found; tag `v1.0.0`.

**Manual Verification Checklist (6b, phase gate)**
1. From a fresh clone in a new folder, the Quick Start reaches an unlocked site with no source edit.
2. A non-member Gmail is denied; chat works through Access; a restore of that site succeeds.
3. The README's first screen states the R2 billing caveat and shows the three themes.
4. `git log -p | grep -iE '@gmail|account_id|api_token'` finds only placeholders.

## 5. Execution risks

1. **SvelteKit's Cloudflare output and a Durable Object in one Worker.** *Mitigation:* 0a proves the wrapping entry
   and the dry-run export before any other slice.
2. **The Access JWT is missing on WebSocket upgrades on some clients.** *Mitigation:* cookie fallback verified the
   same way; 4b tests desktop and iOS Safari through real Access.
3. **The Markdown sanitizer is too heavy for 10 ms CPU.** *Mitigation:* 3a measures on a 10,000-character post and
   picks the lightest allow-list approach that passes AC-BRD-01.
4. **Safari can't encode WebP or decode HEIC.** *Mitigation:* JPEG fallback and a clear refusal (R-MEM-01); 2b's e2e
   runs WebKit.
5. **A command hits the wrong Cloudflare account.** *Mitigation:* `cf.mjs` only, `account_id` in the generated
   config, deploy refusing mismatches, the 0a and 1d checklists comparing both accounts.
6. **Access setup drifts from the app's invite list.** *Mitigation:* `invite` sync with an Access-scoped token, the
   invite screen's both-lists status, preflight's seat and policy checks.
7. **Provider limits change.** *Mitigation:* 1d re-checks §14, and the guardrails are config values.
8. **Outward steps without the owner** (R2 billing, tokens, Zero Trust, Google client, deploys, GitHub remote).
   *Mitigation:* each is a named owner step in 1d, 2c, 4b, 5b and 6b.
9. **A self-hosted Access application on `workers.dev` may not pass WebSocket upgrades.** *Mitigation:* 1d probes it
   with the echo stub before identity or chat depend on it; fallback is a custom domain with one Access application.
