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
- `age` 1.x, for encrypted backups (mandatory: `npm run backup` refuses without it; `brew install age` or your
  package manager).
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
git clone https://github.com/rey5137/classhub.git && cd classhub && npm ci
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
--locale vi --admin you@gmail.com`. If you mistyped the admin email, run setup again and give the right one: it is replaced as long as that admin has not signed in yet. Setup then prints a reminder to update the Access policy: `npm run invite -- remove <old>`, then `npm run invite -- add <new>`.

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
| 6. migrations | — | `npm run db:migrate:remote` (refuses a destructive migration until a verified backup exists) |
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

### Optional: deploy from GitHub Actions

`.github/workflows/deploy.yml` is off by default. It runs only when you start it by hand (`workflow_dispatch`) **and**
the repository variable `ENABLE_DEPLOY` is `true`; it never runs on a push.
The job uses the `production` environment: in the repository settings, add required reviewers to it so a deploy
needs a second approval. Runs queue one at a time and are never cancelled midway. The actions are pinned to commit
SHAs.

Store these repository secrets (Settings → Secrets and variables → Actions):

| Secret | What it is |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | the dedicated account id from `.env.cloudflare` |
| `CLOUDFLARE_API_TOKEN` | the account-scoped token from section 2 |
| `WRANGLER_JSONC` | the whole generated `wrangler.jsonc` from a working checkout (it is gitignored because it holds the account and binding ids) |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | optional; written to `.env.cloudflare` so `deploy` refreshes the Worker vars |
| `AGE_RECIPIENT` | optional; kept for other commands that read `.env.cloudflare` |

The workflow writes `.env.cloudflare` and `wrangler.jsonc` from those secrets, runs `npm run deploy` (which goes
through `scripts/cf.mjs`, INV-9), and deletes both files at the end. No other remote command is allowed from it.

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
| `admin` | an admin is active (before the first unlock: the bootstrap admin has signed in once) |
| `seats` | fewer than 50 Zero Trust seats are used |
| `backup` | a verified backup exists (none yet is a **warning**, never a failure) |
| `destructive-migration` | shown only while a `*_destructive.sql` migration is pending: fails until a verified backup is newer than the last deploy (INV-7) |
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
npm run backup             # must pass: a verified, encrypted backup recorded in backup_runs
npm run db:migrate:remote  # refuses unless the newest verified backup is newer than the last deploy
npm run deploy
npm run smoke:test
```

The order matters (INV-7): `db:migrate:remote` reads the Worker's newest deployment time and the newest verified
`backup_runs` row, and applies nothing unless the backup is newer. It names every pending migration before applying
it, a destructive one (`*_destructive.sql`, R-DB-11) as `DESTRUCTIVE`. It is the only command that applies a
destructive migration to a database in use: `npm run setup` refuses one, and `npm run preflight` fails while one is
pending without that backup. Nothing updates itself; `preflight` tells you when a newer release exists.

Rerun `npm run setup` after an update that changes `wrangler.jsonc.example`: it takes the release keys (`main`,
compatibility settings, `assets`) and any new Durable Object binding or migration tag from it, and keeps your own
values.

## Installable app: manifest and icons (R-NAV-07)

Android's install service fetches `/manifest.webmanifest` and the icons without the member's Access cookie, so both sit
in an Access **Bypass** application like `/health`: Zero Trust → **Access → Applications → Add an application →
Self-hosted**, name "Class Hub public", domain = the Worker hostname (and the custom domain, if any), paths
**`manifest.webmanifest`** and **`icons`**, Policy Action **Bypass**, Include **Everyone**. If you also enable join
requests (next section), add `join` and `_app` to this same application. The manifest holds the site name, language
and theme colours only; nothing else under these paths answers without Access. No setup or deploy script creates this
application (they never write Access applications); a deployment without it still works, but Android Chrome shows a
browser badge on the installed icon. Check it in a private window: `https://<worker-hostname>/manifest.webmanifest`
shows the JSON.

**Your own icons.** The default set in `static/icons/` is drawn from `static/favicon.svg`. Either edit `favicon.svg` and
run `node scripts/render-icons.mjs` (Playwright's Chromium), or replace the four PNGs by hand with the same names and
sizes: `icon-192.png` (192 px), `icon-512.png` (512 px), `icon-maskable-512.png` (512 px, keep the mark inside the
centre 80% so a round mask doesn't cut it) and `apple-touch-icon.png` (180 px, opaque). Set the label under the icon
with `shortName` in `site.config.ts` (otherwise the site name is used). Then `npm run deploy`.

## Join requests (optional, R-AUTH-27..30)

`/join` is a public form where someone who isn't invited yet can ask to be. It is off until an admin ticks
"Let people ask to join" in `/admin` → Site settings; while off it answers 404. Approving a request on `/admin` adds an
ordinary invite (then add the email to the Access policy as for any invite); nobody gets in from the form alone.
Before turning it on:

1. **Turnstile widget.** Cloudflare dashboard (the deployment's account) → **Turnstile → Add widget**: name
   "Class Hub join", hostname = the Worker hostname (and the custom domain, if any), mode **Managed**. Copy the site
   key and the secret key.
2. **Keys into the Worker.** Add the site key to `vars` in `wrangler.jsonc`:
   `"TURNSTILE_SITE_KEY": "<site key>"` (public; setup keeps it on later runs). Store the secret as a Worker secret:
   `node scripts/cf.mjs secret put TURNSTILE_SECRET_KEY` and paste it when asked (it goes in on stdin, never in a
   file). Then `npm run deploy`. Without both, every request is refused with "try again" and nothing is stored.
3. **The `/join` bypass.** Like the `/health` bypass (GOOGLE_ACCESS.md section 4): in the "Class Hub public"
   application already created above (Installable app), add more paths: **`join`**, **`privacy`** (the public privacy page, R-AUTH-32) and **`_app`** (the public
   build assets: the page's styles, scripts and fonts, which hold no member data; without them `/join` loads
   unstyled for someone who isn't signed in). Every other path stays behind the Class Hub application, and the app
   still answers `/join` only while the setting is on.
4. **Check it.** In a private window open `https://<worker-hostname>/join`: the form, with the Turnstile box. Send a
   request; it shows on `/admin` under "Join requests".

Locally, `npm run dev:offline` uses Cloudflare's documented test keys (site key `1x00000000000000000000AA`, secret
`1x0000000000000000000000000000000AA`) and answers them without the network; set `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY` in the environment to try real keys. Requests nobody answers are deleted after 30 days by the
traffic housekeeping run; at most 20 (`join.maxPending` in `site.config.ts`, 1–50) wait at once, and never more than
the free seats.

## Invite email (R-AUTH-31)

Optional. With it, each pending invite on `/admin` gets a **Send invite email** button that emails the person, in
Vietnamese, that they can now sign in. Press it after the address is in the Access policy, or right away with the External Evaluation rule (R-AUTH-33). The email is sent from
your own Gmail account:

1. Turn on 2-Step Verification for that Google account, then create an app password at
   <https://myaccount.google.com/apppasswords> (name it "Class Hub").
2. `node scripts/cf.mjs secret put GMAIL_USER` and paste the Gmail address; `node scripts/cf.mjs secret put
   GMAIL_APP_PASSWORD` and paste the 16-letter app password (spaces are fine). Both go in on stdin.
3. `npm run deploy`. Gmail allows about 500 emails a day; recipients see your Gmail address as the sender.

Locally, the offline build prints the email in the terminal instead of sending it.

## Access asks the site (optional, R-AUTH-33)

With this, inviting or approving someone on `/admin` is enough: Access asks the site at login whether the email
is an active member or has a pending invite, so `npm run invite -- add` is no longer needed for each person.

1. `npm run access-eval -- key`: puts a new RSA key in the `ACCESS_EVAL_KEY` Worker secret (`--rotate` replaces it).
2. `npm run deploy`, then check `https://<site>/access-eval/keys` answers a JSON key set (it is 404 without the key).
3. In the Bypass application (Installable app, above), add the paths **`access-eval`** and **`access-eval/keys`**.
4. `npm run access-eval -- rule https://<site>`: adds the External Evaluation include rule to the Access policy,
   next to its email rules (needs the Access: Apps and Policies Edit token, like `invite`).

Sign in with an invited address to try it. Removing someone is unchanged: suspend them on `/admin` (the site then
answers no at their next login) and `npm run invite -- remove` if their email is also in the policy. After
`key --rotate` and a deploy, logins that rely on the rule may fail until Access refetches the keys URL; the email
rules keep working.

## Backups (R-BAK-03, R-BAK-04, R-BAK-05)

One-time preparation:

1. Install `age` (prerequisites) and create a key pair **on another machine or a password manager**, not next to the
   archives: `age-keygen -o classhub-backup-key.txt`. It prints the public key (`age1…`).
2. Put that public key in `.env.cloudflare` as `AGE_RECIPIENT`. The private key file (the *identity*) never goes
   into the repo, `.env.cloudflare` or the folder that holds the archives: whoever has both can read every member's
   data.
3. Create an R2 API token with **Object Read only**, scoped to the `<slug>-media` bucket (Dashboard → R2 → Manage
   API tokens), and put its pair in `.env.cloudflare` as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Backups never
   use the housekeeping pair.

Run a backup at least weekly and before every update:

```bash
npm run backup                      # → backups/classhub-backup-<time>.tar.age
npm run backup -- --out /Volumes/x  # another folder; --recipient age1… overrides AGE_RECIPIENT
npm run backup -- --prune-old       # then keep the newest per week (12 weeks) and per month (12 months)
```

`backup` takes the backup lock (`.wrangler/backup.lock`; a second run, `export-chat` or `prune-chat` refuses while it
is held), reads every table's row count, exports D1 through the account guard, writes the `portable/` NDJSON copy
from that export, copies every photo and avatar in full over the S3 API, writes `manifest.json`, `checksums.sha256`
and `RESTORE.md`, verifies the snapshot (including that the export holds at least the rows counted before it in the
tables that are never hard-deleted (R-DB-13), that no file holds your account id or a token, and that no file the
backup writes itself names a Cloudflare endpoint or your Access team domain), and only then encrypts it. The plaintext
staging folder is private to your user and removed whether the run succeeds or fails; the `.tar.age` is the only file
left. A verified run is recorded in D1 (`backup_runs`: the time of the database export, object count and size, no
content), which `preflight`,
`db:migrate:remote` and `/admin` read. Without `age` or a recipient it refuses before reading anything.

`--prune-old` deletes older `classhub-backup-*.tar.age` files in the output folder, only after the new one verified
and was recorded, and never the one it just wrote; it never touches R2 or any other file, and a file it cannot delete
is reported without failing the backup. The output folder holds one site's backups only: if you back up several
sites, give each its own `--out` folder, or one site's backups count against another's weeks and months.
`verify-backup` checks for the account id and tokens only on a machine with `.env.cloudflare`, and says so otherwise.
A Cloudflare endpoint or your team domain in what members or admins wrote (a sign-out link in an info page, say) is
theirs to keep: the backup still verifies and prints a warning naming the table and row.

A photo deleted between the database export and the object copy is still copied, since deleted photos keep their
files for `deletedMediaGraceDays`; if its files are already gone it is listed in the manifest as skipped; any other
missing object fails the backup. If a run was killed and the lock remains, `backup` names the file: remove it once you
are sure no backup is running.

Copy the archive somewhere outside Cloudflare (a USB disk, another cloud); `backups/` is gitignored. Check an
archive at any time, on the machine that has the identity:

```bash
npm run verify-backup -- backups/classhub-backup-<time>.tar.age --identity ~/classhub-backup-key.txt
```

It decrypts into a private temporary folder (removed afterwards) and checks the `completed` flag, every checksum,
that `database.sql` loads into SQLite with the manifest's row counts, and that every photo's object has the size and
SHA-256 its database row records. `AGE_IDENTITY_FILE` may stand in for `--identity`; an extracted folder needs no
identity. Each archive's `RESTORE.md` names the app version and the restore commands.

### Chat retention (R-CHAT-13, R-CHAT-14, R-CHAT-18)

Chat keeps messages newer than `chat.retainDays` and at most `chat.maxMessages` (`site.config.ts`). When older ones
exist, `/admin` shows *chat over retention*. Archive them first, then prune:

```bash
npm run export-chat -- --identity ~/classhub-backup-key.txt  # → backups/chat/<fromId>_<toId>.ndjson.age
npm run prune-chat                                            # deletes only what a verified archive holds
```

`export-chat` writes one age-encrypted NDJSON file per month of old messages (deleted messages are left out), never
replaces an existing file, then decrypts each file it wrote with the identity and checks its record count and SHA-256
against D1 before recording it in `chat_archives`. The identity is used for that one run: keep it off the machine and
folder that hold the archives. `prune-chat` deletes nothing without a verified archive; it deletes in chunks of 500
and at most 3,000 messages per run (D1's daily write allowance), so run it again until it reports no archived messages
remain. Both take the backup lock. `--local` runs either against the `dev:offline` database (`CLASSHUB_DB`, else
`data/dev.sqlite`); `npm run db:seed:demo -- --chat-volume 31000` fills a local room for a rehearsal.

## 10. The WebSocket probe (R-OPS-16)

Chat needs a WebSocket through Access. Cloudflare documents that Worker-level Access answers upgrades with `403`; a
self-hosted application on `workers.dev` is unverified, so slice 1d proved it with a temporary echo before chat was
built. Slice 4a removed the probe; the steps below record how the check was run, and chat's own socket is
`/api/v1/chat/ws`.

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
4. Remove `WS_PROBE` from `vars` and `npm run deploy` again. The probe code itself was removed in slice 4a.
5. Record the result here:

   | Date | Browser | Signed in | Without session | Result |
   |---|---|---|---|---|
   | 2026-11-06 | Orca (Chromium) | 101 + echo | 302 | pass |

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
