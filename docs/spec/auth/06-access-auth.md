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

- **R-AUTH-03** On every request except `/health` and static assets, the Access identity adapter reads the
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
  with the invite's role). The first verified login with that email sets the user `active`, the invite `accepted`,
  and stores the JWT `sub` for re-linking checks (§13.5). An email with no invite is never auto-created.
- **R-AUTH-09** **Revoke and suspend:** the internal status changes first (immediate denial, R-NAV-04, R-CHAT-09),
  then the email is removed from the Access policy (R-AUTH-18). Reactivation reverses both.
- **R-AUTH-10** The admin invite screen shows, per email, whether it is in the app list, in the Access policy, or both,
  when the token can read the policy; otherwise it shows the manual step.
- **R-AUTH-11** **Uniform denial.** A valid Google identity without an active membership, an invited-but-revoked
  email and a suspended user all get the same `/denied` page and the same `403 { error: { code: "forbidden" } }`, with
  no hint whether the email is known. Denials are not logged with the email (only a salted hash and the reason).

## 6.4 Setup lock and bootstrap

- **R-AUTH-12** **Locked by default.** The site is locked until `site_settings.setup_state = "unlocked"`, which only
  `npm run unlock` sets (R-OPS-11). While locked, or whenever `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` is missing, every
  page renders `/locked` and every API returns `423 locked`, except that the **bootstrap admin** (the single invite
  created by `setup`) may sign in through verified Access and see `/admin/setup`, a checklist page with no member
  data. A deployment visited before Access is attached shows nothing private.
- **R-AUTH-13** **No identity bypass in production.** No `X-Debug-User`, `?as_user=`, test token or dev identity exists
  in a production build: the dev identity adapter lives in `adapters/local/` and is imported only under
  `import.meta.env.DEV`, and the build test scans the bundle for it (AC-PLAT-09).
- **R-AUTH-14** A second admin is recommended at unlock time and on `/admin` while only one exists (§15 risk
  "admin leaves").
- **R-AUTH-15** **Email PIN fallback.** `docs/GOOGLE_ACCESS.md` documents Access's one-time PIN as an alternative
  login method for first deployments; the app's checks are identical, since the JWT carries the same verified email.

## 6.5 Requests, sessions and CSRF

- **R-AUTH-16** The app keeps no session of its own: the Access cookie is the session, and every request is
  re-verified (R-AUTH-03). Logout links to `/cdn-cgi/access/logout`.
- **R-AUTH-17** **Mutating requests** (`POST`, `PUT`, `PATCH`, `DELETE`, and the WebSocket upgrade) require an
  `Origin` header equal to the site origin (SvelteKit's `csrf.checkOrigin` for forms, and the same check in the API
  helper and the WebSocket route); JSON APIs require `Content-Type: application/json` except media uploads, which
  require the declared image type (R-MEM-08).

## 6.6 Access policy sync

- **R-AUTH-18** `npm run invite -- add|remove|list <email>` and the admin invite screen change the app list; when
  `.env.cloudflare` has a token with Access: Apps and Policies Edit, `invite` also updates the Access application's
  email include rule through the Cloudflare API, and records `access_synced_at`. Without that scope it prints the
  exact dashboard step. The Worker never holds a Cloudflare API token: Access changes run from the CLI only, and the
  admin screen shows the command to run.
- **R-AUTH-19** **Seats:** the invite screen counts active + pending invites against the 50-seat Zero Trust Free
  limit, warns at 45 and refuses at 50 (R-BUD-06).

## 6.7 Headers, limits and hygiene

- **R-AUTH-20** **Headers on every response:** `Content-Security-Policy` (`default-src 'self'`; `img-src 'self' blob:
  data:`; `connect-src 'self'` plus the same-origin WebSocket; `script-src 'self'` with SvelteKit's nonce mode;
  `frame-ancestors 'none'`; `form-action 'self'`; `base-uri 'none'`), `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy` with camera,
  microphone and geolocation off, and `X-Robots-Tag: noindex, nofollow`. `robots.txt` disallows everything as a
  secondary measure only.
- **R-AUTH-21** **Server-side rate limits:** posts and comments 10 per minute per member; uploads 25 photos per day and
  2 concurrent per member (R-MEM-13); chat 1 per second, burst 5 (R-CHAT-05); profile writes 20 per hour; invite
  changes 30 per hour per admin. Exceeding one returns `429 rate_limited` with `Retry-After`.
- **R-AUTH-22** **Bodies are bounded** before parsing: 64 KB for JSON, the media limits for uploads (R-MEM-08), 4 KB
  for a chat frame.
- **R-AUTH-23** **Logs** carry a request id, route, status and a salted member-id hash, never emails, contact
  fields, message bodies, captions or JWTs. Errors use `{ error: { code, message, requestId } }` (§11.1).
- **R-AUTH-24** No third-party analytics, embeds, fonts or scripts by default.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-AUTH-01 | A request with no assertion, an unsigned (`alg: none`) JWT, a JWT signed by another key, wrong `aud`, wrong `iss` or expired gets the uniform denial | R-AUTH-03 | `test:security` with a local JWKS |
| AC-AUTH-02 | A forged `Cf-Access-Authenticated-User-Email` header without a valid JWT is denied | R-AUTH-03 | `test:security` |
| AC-AUTH-03 | An unknown `kid` triggers one JWKS refetch; a failed fetch with no cache denies | R-AUTH-04 | unit with fake fetch |
| AC-AUTH-04 | An invited email becomes active on first verified login; an uninvited one gets `/denied` and no row | R-AUTH-08, 11 | integration |
| AC-AUTH-05 | Responses for an unknown email, a revoked invite and a suspended user are byte-identical apart from the request id | R-AUTH-11 | `test:security` |
| AC-AUTH-06 | While locked, every page and API reveals no seeded data to anyone but the bootstrap admin's setup page | R-AUTH-12 | integration |
| AC-AUTH-07 | A cross-origin `POST`, `PATCH`, `DELETE` and WebSocket upgrade are refused | R-AUTH-17 | `test:security` |
| AC-AUTH-08 | Every response carries the §6.7 headers | R-AUTH-20 | integration |
| AC-AUTH-09 | Each rate limit of R-AUTH-21 returns `429` past its threshold | R-AUTH-21 | integration |
| AC-AUTH-10 | In production, an allowed Gmail account reaches the site and a non-allowed Gmail account is stopped by Access and, with a forged path around it, by the app | R-AUTH-01, 07 | manual 1d |
| AC-AUTH-11 | `invite add`/`remove` with an Access-scoped token updates the Access policy; without it, prints the dashboard step | R-AUTH-18 | unit with fake API + manual 1d |
| AC-AUTH-12 | No log line in the test run contains a fixture email, phone or message body | R-AUTH-23 | `test:security` log capture |
