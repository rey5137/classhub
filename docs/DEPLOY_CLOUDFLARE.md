# Deploying Class Hub to Cloudflare

This guide takes a fresh clone to a running, locked deployment, then to an unlocked site that only approved
classmates can open. Access and Google sign-in have their own walkthrough: [GOOGLE_ACCESS.md](GOOGLE_ACCESS.md).

Spec: `docs/spec/ops/12-deploy.md` (§12), the account guard `docs/spec/platform/02-platform-repo.md` (§2.6) and the
free-tier budget `docs/spec/platform/14-free-tier-budget.md` (§14).

## Read this first: what it can cost

- **R2 must be activated in the dashboard, and that needs a payment method.** The free allowance (10 GB-month of
  storage, 1 M Class A and 10 M Class B operations a month, §14.1) covers a class of 50 many times over, but overage
  is billed.
- **The app's storage cap is not a billing cap.** Class Hub stops uploads at 9 GB (warns at 8 GB), but another app in
  the same account, unexpected operations, or provider overage can still bill.
- **Use a dedicated Cloudflare account for Class Hub**, so its usage and any R2 overage are never mixed with other
  projects, and **turn on billing notifications** (Manage Account → Billing → Notifications).
- Other possible costs: a custom domain (only needed for the fallback below), off-site storage for your backups,
  and overage on any product.

## 1. Prerequisites (R-OPS-01)

- Node.js 24 or newer (`node --version`), npm and Git.
- `age`, for encrypted backups (mandatory once backups arrive; install it now: `brew install age` or your package
  manager).
- A Cloudflare account on **Workers Free** with a **Zero Trust Free** organization (created in GOOGLE_ACCESS.md).
- **R2 activated** in that account: Dashboard → R2 Object Storage → Purchase / Activate (asks for a payment method).
  > screenshot: the R2 activation screen
- A Google account to create the OAuth client (no Google Workspace needed).
- Optionally a domain. Without one, the site lives on the free `workers.dev` hostname; a custom domain is the fallback
  if WebSockets don't pass Access on `workers.dev` (see "The WebSocket probe").

## 2. The target account (R-OPS-02, R-OPS-03)

Class Hub never uses your global `wrangler login`. Every Cloudflare command runs through `scripts/cf.mjs`, which reads
the gitignored `.env.cloudflare`, checks that its token sees exactly that one account, and refuses to run otherwise.

1. Create (or pick) the dedicated account. Copy its **Account ID** from Dashboard → Account home (right column).
2. Create an **account-scoped API token**: My Profile → API Tokens → Create Token → Create Custom Token, with
   **Account resources: Include → that account** and these permissions:
   - Account · Workers Scripts · Edit
   - Account · D1 · Edit
   - Account · Workers R2 Storage · Edit
   - Account · Account Settings · Read
   - Account · Access: Apps and Policies · Edit (optional: lets `npm run invite` keep the Access email list in sync)
   > screenshot: the custom token's permission list
3. `cp .env.cloudflare.example .env.cloudflare` and fill `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

**Everything lives in that one account:** Zero Trust (Access), D1, R2, the Worker and its `workers.dev` subdomain. An
Access application created in a different account does **not** protect the Worker.

## 3. Quick start

```bash
git clone https://github.com/<OWNER>/classhub.git && cd classhub && npm ci
cp .env.cloudflare.example .env.cloudflare   # fill CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
npm run setup        # D1, private R2, wrangler.jsonc, secrets, migrations, bootstrap admin invite
npm run deploy       # deploys locked
# configure Access + Google with docs/GOOGLE_ACCESS.md, using the values setup printed
npm run preflight    # checks account, bindings, Access, hostnames, bucket privacy, migrations
npm run unlock       # opens the site to approved members
```

No source file needs editing (AC-OPS-02): everything account-specific is in `.env.cloudflare` and the generated,
gitignored `wrangler.jsonc`.

## 4. `npm run setup` (R-OPS-04)

Interactive and safe to re-run. It asks the **project slug** (the Worker name, e.g. `classhub`), and, while the
database has none yet, the **site title**, **default theme**, **language** and the **bootstrap admin email** (yours).
Each answer can also be passed as a flag: `npm run setup -- --slug classhub --title "Lớp 12A" --theme yearbook
--locale vi --admin you@gmail.com`.

What it does, in order:

1. checks Node, `.env.cloudflare`, that the token sees the account, and any existing `wrangler.jsonc` (it refuses if
   that file names another account);
2. asks the slug;
3. lists D1 and R2 first, then creates `<slug>-db` and the private bucket `<slug>-media` **only if missing**; it never
   deletes anything;
4. writes `wrangler.jsonc` from `wrangler.jsonc.example`: your `account_id`, the name, the `DB`/`MEDIA` bindings, the
   `CHAT_ROOM` Durable Object (SQLite class `ChatRoom`), `workers_dev: true` (a rerun keeps your `false`),
   `preview_urls: false`, and the vars
   `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` (empty until Access exists). Values you added yourself (other vars, `routes`)
   are kept;
5. creates the Worker secrets `INTERNAL_CONTEXT_KEY` and `LOG_HASH_SALT` if they are missing (random, never shown);
6. applies the remote migrations, then seeds only the site settings and the bootstrap admin invite, never demo
   content and never over existing members; the site starts **locked**;
7. prints what you need next, never a secret:

```text
Class Hub setup is complete:
  Account id:           0123456789abcdef0123456789abcdef
  Worker hostname:      classhub.<your-subdomain>.workers.dev
  D1 database:          classhub-db (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  R2 bucket:            classhub-media
  Bootstrap admin:      you@gmail.com
  Google redirect URI:  https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback
```

A second run reports `exists, reused` / `exists, kept` for each resource and prints the same values.

### Setup by hand (R-OPS-05)

If a step fails, do it yourself and re-run `npm run setup`; it picks up whatever already exists. Every command goes
through the account guard (`node scripts/cf.mjs …`), never `npx wrangler`.

| Step | Dashboard | Command |
|---|---|---|
| 1. token check | My Profile → API Tokens → your token → "Verify" | `node scripts/cf.mjs whoami` |
| 3. D1 | Workers & Pages → D1 → Create database `<slug>-db` | `node scripts/cf.mjs d1 list --json`, then `node scripts/cf.mjs d1 create <slug>-db --update-config=false` |
| 3. R2 | R2 → Create bucket `<slug>-media` (no public access, no custom domain) | `node scripts/cf.mjs r2 bucket create <slug>-media --update-config=false` |
| 4. config | — | `cp wrangler.jsonc.example wrangler.jsonc`; set `account_id`, `name`, `database_name`/`database_id` (from `d1 list`), `bucket_name`, and add `"vars": { "ACCESS_TEAM_DOMAIN": "", "ACCESS_AUD": "" }` |
| 5. secrets | Workers & Pages → `<slug>` → Settings → Variables and Secrets → Add (type Secret) | `node scripts/cf.mjs secret put INTERNAL_CONTEXT_KEY` and `… LOG_HASH_SALT`; paste a long random value (`openssl rand -base64 32`) at the prompt |
| 6. migrations | — | `node scripts/cf.mjs d1 migrations apply DB --remote` |
| 6. seed | — | re-run `npm run setup` (it only seeds what is missing), or `npm run invite -- add <email> --role admin` once an admin exists |
| 7. hostname | Workers & Pages → Overview → your subdomain (right column) | — |

> screenshot: the D1 database list and the bucket's Settings page

## 5. `npm run deploy` (R-OPS-08)

`npm run deploy` runs, in order:

1. the account guard: refuses when `wrangler.jsonc`'s `account_id` differs from `.env.cloudflare` (AC-OPS-03);
2. `scripts/deploy-check.mjs`: refuses when the database has migrations this checkout doesn't know (the deployed
   schema is ahead of the code: `git pull --ff-only` first), and writes `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` from
   `.env.cloudflare` into `wrangler.jsonc`;
3. the build and the Worker bundle check;
4. the deploy itself.

A first deploy before Access exists is safe: with no `ACCESS_*` values every page shows `/locked` and nothing private
is reachable (R-AUTH-12).

## 6. Access and Google

Follow [GOOGLE_ACCESS.md](GOOGLE_ACCESS.md), using the hostname and redirect URI that setup printed. It ends with the
team domain and AUD in `.env.cloudflare` and a second `npm run deploy`.

## 7. Preflight, unlock and lock (R-OPS-10, R-OPS-11)

`npm run preflight` prints one line per item, `PASS`, `FAIL` (with a `fix:` line), `WARN` or `INFO`, and exits nonzero
when anything fails:

| Item | Passes when |
|---|---|
| `account` | `wrangler.jsonc` and `.env.cloudflare` name the same account and the token sees only it |
| `bindings` | `DB`, `MEDIA` and `CHAT_ROOM` are declared and the database and bucket exist in the account |
| `migrations` | every repo migration is applied remotely and none is unknown to this checkout (a pending one fails until applied, so nothing destructive slips through) |
| `access` | `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are deployed, match `.env.cloudflare`, and the team JWKS loads |
| `hostnames` | every hostname of the Worker, without a cookie, redirects to `<team>.cloudflareaccess.com` |
| `preview` | preview URLs are off |
| `bucket` | the bucket has no public `r2.dev` URL and no custom domain |
| `admin` | the bootstrap admin has signed in once and is active |
| `seats` | fewer than 50 Zero Trust seats are used |
| `backup` | a verified backup exists (until `npm run backup` arrives this is a **warning**, never a failure) |
| `release` | information only: the newest GitHub release compared with your version |

`npm run unlock` runs preflight and sets the site to `unlocked` only if everything passes. While you are the only
admin it recommends adding a second one (`npm run invite -- add <email> --role admin`).

`npm run lock` is the emergency switch: it locks the site at once, without checks. Every page then shows `/locked`
and every API answers `423`; `npm run unlock` reopens it. Both are recorded in the audit log.

## 8. Smoke test (R-OPS-09)

`npm run smoke:test` (after every deploy) confirms, for each hostname, that `/health` answers `{ ok: true, version }`
with this checkout's version, and that the site without a cookie redirects to Access. Pass `-- --host <hostname>` to
test a specific hostname. A `/health` that redirects to Access means the `/health` bypass application is missing
(GOOGLE_ACCESS.md section 4, "The /health bypass").

## 9. Updating (R-OPS-12)

```bash
git pull --ff-only
npm ci
npm run backup             # must pass (arrives in a later release)
npm run db:migrate:remote  # refuses without a backup newer than the last deploy (arrives with backups)
npm run deploy
npm run smoke:test
```

Until `backup` and `db:migrate:remote` exist, run `npm run preflight` after `npm ci`: a pending migration shows as a
failure with the exact command, and no destructive migration exists yet. Nothing updates itself; `preflight` tells you
when a newer release exists.

Rerun `npm run setup` after an update that changes `wrangler.jsonc.example`: it takes the release keys (`main`,
compatibility settings, `assets`) and any new Durable Object binding or migration tag from it, and keeps your own
values.

## 10. The WebSocket probe (R-OPS-16)

Chat needs a WebSocket through Access. Cloudflare documents that Worker-level Access answers upgrades with `403`; a
self-hosted application on `workers.dev` is unverified, so slice 1d proves it with a temporary echo before chat is
built. Do this after the site is unlocked.

1. In `wrangler.jsonc`, add `"WS_PROBE": "1"` to `vars`, then `npm run deploy`. (Without it `/__probe/ws` is a 404.)
2. Open the site in a browser where you are signed in, open DevTools → Console, and paste:

   ```js
   const ws = new WebSocket(`wss://${location.host}/__probe/ws`);
   ws.onopen = () => {
     console.log('probe: 101 Switching Protocols, socket open');
     ws.send(`echo ${Date.now()}`);
   };
   ws.onmessage = (event) => {
     console.log('probe: echoed', event.data);
     ws.close(1000);
   };
   ws.onerror = () => console.log('probe: refused or failed; see Network → WS for the status');
   ```

   **Expected:** `probe: 101 Switching Protocols, socket open`, then `probe: echoed echo <number>`. DevTools → Network
   → WS shows `/__probe/ws` with status `101`.
   > screenshot: the console lines and the 101 in the Network tab
3. Without a session the probe must be refused. From a terminal (no cookie):

   ```bash
   curl -si -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Version: 13' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://<worker-hostname>/__probe/ws | head -3
   ```

   **Expected:** a `302` to `<team>.cloudflareaccess.com` (or a `403`), never `101`.
4. Remove `WS_PROBE` from `vars` and `npm run deploy` again. The probe code itself is removed in slice 4a.
5. Record the result here:

   | Date | Browser | Signed in | Without session | Result |
   |---|---|---|---|---|
   | _owner fills in_ | | 101 + echo? | 302/403? | pass / fail |

**If the signed-in probe fails** (a `403`, or the socket never opens): stop and take the custom-domain decision before
Phase 2. Nothing built so far depends on the outcome; chat (4a/4b) does.

### Fallback: a custom domain

1. Add the domain to the **same** Cloudflare account (Websites → Add a site) and add it to the Worker:
   `"routes": [{ "pattern": "class.example.com", "custom_domain": true }]` in `wrangler.jsonc`, then `npm run deploy`.
   Setup keeps this entry on later runs.
2. Edit the **one** Access application so it lists **both** hostnames (`class.example.com` and the `workers.dev` one).
   One application means one AUD, so `ACCESS_AUD` does not change. Add the custom hostname (path `health`) to the
   "Class Hub health" bypass application too, so `npm run smoke:test` can load `/health` there.
3. `workers.dev` must stay protected by that application or be switched off (`"workers_dev": false`); an unprotected
   hostname would bypass Access (R-AUTH-02). Preflight checks every hostname.
4. Repeat the probe on the custom domain.

## 11. First-deploy checklist (slice 1d)

Do each step and tick it. Each one proves something specific: AC-OPS-01/02, AC-AUTH-10, AC-AUTH-11 and R-OPS-16.

1. **Setup twice.** `npm run setup`, then `npm run setup` again. The second run says `exists, reused` / `exists, kept`
   for the database, bucket and secrets, creates nothing, and prints the same values.
2. **Locked before Access.** `npm run deploy`, then open `https://<worker-hostname>/` in a private window: `/locked`,
   no names, no data.
3. **Bootstrap admin.** After GOOGLE_ACCESS.md (and the second deploy), sign in with the bootstrap admin Gmail: you
   see the `/admin/setup` checklist only; other pages send you back to it.
4. **Preflight and unlock.** `npm run preflight` lists every item `PASS` (the backup `WARN` is expected);
   `npm run unlock` succeeds.
5. **Invites.** `npm run invite -- add <second-gmail>`; that account reaches the site. A third, uninvited Gmail is
   stopped at the Access screen.
6. **The app's own check.** Suspend the second Gmail in `/admin` → Members. The admin screen changes the app's list
   only (`npm run invite -- remove` would also update the Access policy), so Access still lets it through, and the app
   shows it `/denied` (AC-AUTH-10).
7. **One-time PIN.** Invite a non-Gmail address; it signs in with the emailed PIN and reaches the site.
8. **The right account.** In the dashboard of the **dedicated** account: the Worker, D1 database, bucket and Access
   application are there. Your other account shows none of them.
9. **Privacy across accounts.** On one member, set the phone to *members*; another member sees it. Set it back to
   *private*; it is gone for them.
10. **WebSocket probe.** Section 10: `101` and an echo when signed in, refused without a session. If not, take the
    custom-domain decision before Phase 2.

A fresh clone repeats steps 1–4 without editing any source file (AC-OPS-02; repeated in slice 6b from a clean clone).
