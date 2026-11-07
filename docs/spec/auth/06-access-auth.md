# 06 — Access, membership and security

**Covers:** Cloudflare Access in front of the hostname, Access JWT verification, membership, invites and Access sync, the setup lock, sessions and CSRF, security headers, rate limits, enumeration.
**Read when:** touching `hooks.server.ts`, the identity adapter, invites, roles, any mutating route, headers or limits.
**Owns:** `R-AUTH-*`, `AC-AUTH-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§6.n` is in this file.

---

## 6.1 Access in front of the site

- **R-AUTH-01** Production login is Cloudflare Access (Zero Trust Free organization **in the deployment's own account**,
  §2.6) with **Google** as identity provider (no Workspace needed). The Access application is **self-hosted and
  hostname-based**, matching the exact Worker hostname (`<worker>.<subdomain>.workers.dev` or a custom hostname), with
  a policy that includes only the listed email addresses. Never allow a whole domain (`gmail.com`) or "any
  authenticated user", and never enable Worker-level Access on this Worker (D6).
- **R-AUTH-02** **Every exposed hostname is protected.** Preview URLs are off (R-PLAT-02); a custom domain and the
  `workers.dev` hostname are each covered by an Access application, or `workers.dev` is turned off. `preflight`
  requests each known hostname without a cookie and fails unless it is redirected to Access (R-OPS-10).

## 6.2 Verifying identity in the app

- **R-AUTH-03** On every request except `/health`, `/manifest.webmanifest` and `/icons/` (R-NAV-07), `/join` (R-AUTH-27) and static assets (the public build assets under `/_app/`, served before the Worker), the Access identity adapter reads the
  `Cf-Access-Jwt-Assertion` header (falling back to the `CF_Authorization` cookie only for the WebSocket upgrade, where
  some clients don't forward the header) and verifies it with `jose`: RS256 signature against the team JWKS
  (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), `iss` equal to the team domain, `aud` containing the
  configured application AUD, `exp`/`nbf` with 60 s leeway, and a non-empty `email` claim. The
  `Cf-Access-Authenticated-User-Email` header is never trusted by itself.
- **R-AUTH-04** **JWKS cache:** keys are cached in memory per isolate for at most 10 minutes; an unknown `kid` forces
  one refetch (key rotation), rate-limited to one per minute. A JWKS fetch failure with no cached key denies (INV-1).
- **R-AUTH-05** The team domain and AUD come from Worker vars `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (not secrets, but
  account-specific: kept in the gitignored `.env.cloudflare` and written into the generated `wrangler.jsonc` by `setup`
  and `deploy`, R-PLAT-13). A missing value means locked (R-AUTH-12).
- **R-AUTH-06** The verified email is normalized (trim, lower-case; no Gmail dot or plus folding, which would merge
  different accounts on other providers) and looked up in `users`.

## 6.3 Membership and invites

- **R-AUTH-07** **Two layers.** Access decides who may reach the hostname; the app decides who may see data. A request
  passes only if Access verification succeeded **and** the email maps to an `active` user (INV-1).
- **R-AUTH-08** **Invite → active.** An admin invites an email (`invites` row `pending` and a `users` row `invited`
  with the invite's role). The first verified login with that email activates it with a **guarded** statement in one
  batch: `UPDATE users SET status = 'active' WHERE auth_email = ? AND status = 'invited' AND EXISTS (SELECT 1 FROM
  invites WHERE email = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > now))`, followed by marking the
  invite `accepted` in the same batch; zero rows changed means the uniform denial (R-AUTH-11). An email with no invite
  is never auto-created. **Revoking an invite** sets it `revoked` and deletes the never-active `users` row (or marks
  it `suspended` when the row has any history), so a revoked email can never activate. **Invite expiry:** each invite
  has `expires_at`, default 30 days after creation (`invite.expiryDays`, configurable; `null` means never); an expired
  invite behaves like a revoked one and an admin can re-invite: because `invites.email` is unique and never hard-deleted (R-DB-13), re-inviting a `revoked` or expired email updates that row to `pending` (new `expires_at`, `role`, `invited_by`) and is audited.
- **R-AUTH-25** **Subject check.** Matching stays by normalized email (R-AUTH-06), also when re-linking after a restore
  (R-BAK-14). The Access JWT `sub` is stored in `users.access_sub` on first login; a later login with the same email
  but a different `sub` is still matched by email and recorded as an audit event (`access_sub_changed`, no email in
  the log, R-AUTH-23) and `access_sub` is updated. A restore clears `access_sub` so re-linking by email stays valid.
- **R-AUTH-26** `users.last_seen_at` is written at most once per hour per member (a conditional
  `UPDATE … WHERE last_seen_at < now - 1 h`), never on every request, to stay inside the D1 write budget (§14).
- **R-AUTH-09** **Revoke and suspend:** the internal status changes first (immediate denial, R-NAV-04, R-CHAT-09),
  then the email is removed from the Access policy (R-AUTH-18). Reactivation reverses both (`invite add` on a suspended member with an accepted invite reactivates them, then syncs the policy). Revoking a pending invite follows R-AUTH-08.
- **R-AUTH-10** The admin invite screen shows, per email, whether it is in the app list, in the Access policy, or both,
  when the token can read the policy; otherwise it shows the manual step.
- **R-AUTH-11** **Uniform denial.** A valid Google identity without an active membership, an invited-but-revoked
  email and a suspended user all get the same `/denied` page and the same `403 { error: { code: "forbidden" } }`, with
  no hint whether the email is known. Every cause takes the same path per request kind: a page navigation gets
  `303` to `/denied` (itself always `403`), SvelteKit's `__data.json` request gets the same redirect as JSON, and
  everything else (API, WebSocket upgrade, form post) gets `403 forbidden`. Denials are not logged with the email
  (only a salted hash and the reason).

## 6.4 Setup lock and bootstrap

- **R-AUTH-12** **Locked by default.** The site is locked until `site_settings.setup_state = "unlocked"`, which only
  `npm run unlock` sets (R-OPS-11). While locked, or whenever `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` is missing, every
  page renders `/locked` and every API returns `423 locked`, except that the **bootstrap admin** (the single invite
  created by `setup`) may sign in through verified Access and see `/admin/setup`, a checklist page with no member
  data. A deployment visited before Access is attached shows nothing private.
- **R-AUTH-13** **No identity bypass in production.** No `X-Debug-User`, `?as_user=`, test token or dev identity exists
  in a production build: the dev identity adapter lives in `adapters/local/` and is imported only under
  `import.meta.env.DEV`, and the build test scans every file of the bundle for it (AC-PLAT-09). Even in a dev build it answers only a loopback
  peer address with a loopback `Host` (R-PLAT-10).
- **R-AUTH-14** A second admin is recommended at unlock time and on `/admin` while only one exists (§15 risk
  "admin leaves").
- **R-AUTH-15** **Email PIN login.** Access's one-time PIN is enabled as a second login method beside Google, so an
  invited address without a Google account can sign in; `docs/GOOGLE_ACCESS.md` documents both. The app's checks are
  identical, since the JWT carries the same verified email. The app has no passwords of its own.

## 6.5 Requests, sessions and CSRF

- **R-AUTH-16** The app keeps no session of its own: the Access cookie is the session, and every request is
  re-verified (R-AUTH-03). Logout links to `/cdn-cgi/access/logout`.
- **R-AUTH-17** **Mutating requests** (`POST`, `PUT`, `PATCH`, `DELETE`, and the WebSocket upgrade) require an
  `Origin` header equal to the site origin. The check is in the request hook, for every mutating request (forms
  included) and the upgrade; SvelteKit's own form check is off (`csrf.trustedOrigins: ['*']`), so every refusal
  carries the §6.7 headers and the R-API-02 error shape. JSON APIs require `Content-Type: application/json` except
  media uploads, which require the declared image type (R-MEM-08).

## 6.6 Access policy sync

- **R-AUTH-18** `npm run invite -- add|remove|list <email>` and the admin invite screen change the app list; when
  `.env.cloudflare` has a token with Access: Apps and Policies Edit, `invite` also updates the Access application's
  email include rule through the Cloudflare API, and records `access_synced_at`. Without that scope it prints the
  exact dashboard step. The Worker never holds a Cloudflare API token: Access changes run from the CLI only, and the
  admin screen shows the command to run. The policy is read and written through `cf.mjs api`, so the account guard
  runs first (INV-9). `remove` refuses to suspend the last active admin inside the same statement (R-NAV-06), and
  `remove` and a renewed invite clear `access_synced_at`, so the screen's "in the Access policy" label never outlives
  the policy entry. The policy is not touched when the D1 change did not apply.
- **R-AUTH-19** **Seats:** the invite screen counts active + pending invites against the 50-seat Zero Trust Free
  limit, warns at 45 and refuses at 50 (R-BUD-06).

## 6.7 Headers, limits and hygiene

- **R-AUTH-20** **Headers on every response:** `Content-Security-Policy` (`default-src 'self'`; `img-src 'self' blob:
  data:`; `connect-src 'self'` plus the same-origin WebSocket; `script-src 'self'` with SvelteKit's nonce mode;
  `style-src 'self'` plus the page nonce (the inline theme `<style>` in `app.html`), never `'unsafe-inline'`;
  `style-src-attr 'unsafe-inline'` for component `style=` attributes; `frame-ancestors 'none'`; `form-action 'self'`; `base-uri 'none'`), `Referrer-Policy: same-origin`
  (no referrer leaves the site; `no-referrer` would make browsers send `Origin: null` on a native form `POST`, which
  R-AUTH-17 refuses, so forms would need JavaScript),
  `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy` with camera,
  microphone and geolocation off, and `X-Robots-Tag: noindex, nofollow`; **every private HTML page and JSON response also carries `Cache-Control: private, no-store`** (static assets excepted). `robots.txt` disallows everything as a
  secondary measure only.
- **R-AUTH-21** **Server-side rate limits:** posts and comments 10 per minute per member; uploads 25 photos per day and
  2 concurrent per member (R-MEM-13); chat 1 per second, burst 5 (R-CHAT-05); profile writes 20 per hour; notification settings and
  subscription writes 30 per hour per member (R-NTF-10); invite changes 30 per hour per admin. Exceeding one returns `429 rate_limited` with `Retry-After`.
- **R-AUTH-22** **Bodies are bounded** before parsing: 64 KB for JSON, the media limits for uploads (R-MEM-08), 4 KB
  for a chat frame.
- **R-AUTH-23** **Logs** carry a request id, route, status and a salted member-id hash, never emails, contact
  fields, message bodies, captions, JWTs or push endpoints and keys (R-NTF-02). The salt is the Worker secret `LOG_HASH_SALT` (created by `setup`); when
  it is unset (dev, tests) each isolate draws a random salt, and a production build logs one `config` warning without
  any value. Errors use `{ error: { code, message, requestId } }` (§11.1).
- **R-AUTH-24** No third-party analytics, embeds, fonts or scripts by default. The one exception is Turnstile on
  `/join`, and only while join requests are on (R-AUTH-27).

## 6.8 Join requests

- **R-AUTH-27** **Request to join.** `GET` and `POST /join` sit outside the Access policy (a Bypass Access application, like `/health` and
  the install manifest and icons, R-NAV-07, which also covers the public build assets under `/_app/` so the page
  loads styled; they carry no member data), and only while the `join` site setting is on (§10.1; default off); off, both
  answer 404. The page shows the site name and a form: name (1–80), email, a note (≤ 300, e.g. "class and year"). It
  renders no member data, no site media and no counts. A submission needs a valid Turnstile token, verified on the
  server; the Turnstile script and frame are allowed in the CSP of `/join` only.
- **R-AUTH-28** **Uniform reply.** Every accepted submission, whether the email is new, already requested, a member,
  invited, suspended or revoked, gets the same confirmation page. Only a normalised email with no `users` row, no
  pending invite and no pending request creates a `join_requests` row; nothing else is written. The app sends no email.
- **R-AUTH-29** **Limits.** 3 submissions per IP hash per hour, 20 per hour site-wide. At most `join.maxPending`
  pending requests (Level B, default 20, 1–50) and never more than the free seats (R-AUTH-19: 50 − active members −
  pending invites). While the queue is full, `/join` shows a closed notice instead of the form (site-wide state),
  stores nothing, and `/admin` shows the queue as full. Accepted residual signal: when the queue sits one below
  full, a submission followed by a `GET /join` shows whether that email made a row (closed) or not (open); this
  needs a near-full queue and costs 3 tries per IP per hour, so it is left as is. The IP hash uses `LOG_HASH_SALT`;
  a production build without it refuses every submission ("try again"), since per-isolate salts would break the
  per-IP limit. Housekeeping deletes requests older than 30 days; a rejected one is deleted at once.
- **R-AUTH-30** **Review.** Admins see pending requests (name, email, note, time) on `/admin`. Approve runs the invite
  path (R-AUTH-08, R-AUTH-18: invite row, Access policy sync or the manual step, the seat count of R-AUTH-19) and
  deletes the request in the same batch; reject deletes it. Both write an `audit_events` row without the email, name
  or note. Approve refuses (and keeps the request) when the email already has a suspended, active or deleted account, and does nothing once the request was rejected. Approval activates no one: the first verified login does (R-AUTH-08).
- **R-AUTH-31** **Invite email.** A pending, unexpired invite on `/admin` has a "Send invite email" button (and
  `POST /api/v1/admin/invites/:id/email`): the admin presses it once the address is in the Access policy (R-AUTH-18),
  so the email never tells someone to sign in before they can; pressing it again resends. The Worker sends one
  plain-text Vietnamese email from the owner's Gmail over SMTP (`GMAIL_USER` and `GMAIL_APP_PASSWORD` Worker secrets;
  the sender name is the site name) with the site's address, the invitee's name, the inviter's name and the expiry
  date. Nothing is sent automatically on invite or approval. Without both secrets the button is hidden and the route
  answers `unavailable`. It takes the invite rate limit (R-AUTH-21) and writes an `invite.emailed` audit row with
  ids only; a failed send logs no address.
- **R-AUTH-32** **Privacy page.** `GET /privacy` sits outside Access (a path in the same Bypass application as
  `/join`) and answers everyone, before the membership check, with a static Vietnamese summary of `docs/PRIVACY.md`
  and no member data or site media. It is the privacy-policy link on the Google sign-in consent screen, which Google
  requires before the OAuth app can be published for any Gmail account; a change to what the site stores updates both.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-AUTH-01 | A request with no assertion, an unsigned (`alg: none`) JWT, a JWT signed by another key, wrong `aud`, wrong `iss` or expired gets the uniform denial | R-AUTH-03 | `test:security` with a local JWKS |
| AC-AUTH-02 | A forged `Cf-Access-Authenticated-User-Email` header without a valid JWT is denied | R-AUTH-03 | `test:security` |
| AC-AUTH-03 | An unknown `kid` triggers one JWKS refetch; a failed fetch with no cache denies | R-AUTH-04 | unit with fake fetch |
| AC-AUTH-04 | An invited email becomes active on first verified login; an uninvited one gets `/denied` and no row | R-AUTH-08, 11 | integration |
| AC-AUTH-05 | Responses for an unknown email, a revoked invite, an expired invite and a suspended user are identical after removing the request id and the CSP nonce (status, headers and body, with the nonce value replaced by a placeholder in the `Content-Security-Policy` header and in markup) | R-AUTH-11 | `test:security` |
| AC-AUTH-06 | While locked, every page and API reveals no seeded data to anyone but the bootstrap admin's setup page | R-AUTH-12 | integration |
| AC-AUTH-07 | A cross-origin `POST`, `PATCH`, `DELETE` and WebSocket upgrade are refused | R-AUTH-17 | `test:security` |
| AC-AUTH-08 | Every response carries the §6.7 headers | R-AUTH-20 | integration |
| AC-AUTH-09 | Each rate limit of R-AUTH-21 returns `429` past its threshold | R-AUTH-21 | integration |
| AC-AUTH-10 | In production, an allowed Gmail account reaches the site and a non-allowed Gmail account is stopped by Access and, with a forged path around it, by the app | R-AUTH-01, 07 | manual 1d |
| AC-AUTH-11 | `invite add`/`remove` with an Access-scoped token updates the Access policy; without it, prints the dashboard step | R-AUTH-18 | unit with fake API + manual 1d |
| AC-AUTH-12 | No log line in the test run contains a fixture email, phone or message body | R-AUTH-23 | `test:security` log capture |
| AC-AUTH-13 | A login with a revoked or expired invite, whose `users` row was removed or suspended, never becomes `active`; the guarded activation changes zero rows | R-AUTH-08 | integration |
| AC-AUTH-14 | A same-email login with a different `sub` is matched by email and records an audit event; a restore then re-links by email | R-AUTH-25 | integration |
| AC-AUTH-15 | `last_seen_at` is written at most once per hour per member; private HTML and JSON responses carry `Cache-Control: private, no-store` | R-AUTH-26, 20 | integration |
| AC-AUTH-16 | `/join` responses for a new, already requested, member, suspended and revoked email are identical after removing the request id and the CSP nonce | R-AUTH-28 | `test:security` |
| AC-AUTH-17 | Without a valid Turnstile token, over the IP or site-wide rate, or with the queue full (cap or seats), nothing is stored, and a full queue shows the closed notice | R-AUTH-27, 29 | integration |
| AC-AUTH-18 | Approve creates a pending invite and deletes the request in one batch, and the requester stays denied until their first verified login; reject deletes it; both write an audit row without content | R-AUTH-30 | integration |
| AC-AUTH-19 | With `join` off, `/join` answers 404; on, it shows no member data or private media, and every other path still requires Access | R-AUTH-27 | integration + e2e |
| AC-AUTH-20 | The invite email goes only to a pending, unexpired invite, when an admin asks, with the site address, names and expiry, and writes an `invite.emailed` audit row with ids only; without a mailer, for a member or another invite status nothing is sent | R-AUTH-31 | integration |
| AC-AUTH-21 | `GET /privacy` answers 200 with no identity, in a locked or unlocked site alike, and shows no member data | R-AUTH-32 | `test:security` |
