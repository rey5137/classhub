# 12 — Setup, deploy and operations

**Covers:** Prerequisites, the target Cloudflare account, the setup wizard, Access and Google setup, deploy, preflight, unlock, updates, CI/CD.
**Read when:** touching `scripts/setup.mjs`, `preflight.mjs`, `unlock.mjs`, `invite.mjs`, deploy scripts, the wrangler template or the deploy docs.
**Owns:** `R-OPS-*`, `AC-OPS-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§12.n` is in this file.

---

## 12.1 Prerequisites

- **R-OPS-01** The deploy docs list: Node.js 24+, npm, Git; a Cloudflare account with Workers Free and a Zero Trust
  Free organization; **R2 activated in the dashboard, which requires a payment method and may bill overage** despite
  the free allowance; a Google account to create the OAuth client (no Workspace); optionally a domain (otherwise
  `workers.dev` is free).

## 12.2 The target account

- **R-OPS-02** Every deployment names its account explicitly in `.env.cloudflare` (R-PLAT-12). The docs recommend
  **a dedicated Cloudflare account for Class Hub**, so the app's usage and any R2 overage are not mixed with other
  projects (§14), and say how to create an account-scoped API token for it. The reference deployment does exactly
  this: it runs in the maintainer's second account, and the maintainer's global `wrangler login` (another account) is
  never used by this repo.
- **R-OPS-03** Zero Trust (Access), D1, R2, the Worker and its `workers.dev` subdomain all belong to that one account;
  the docs warn that an Access application in a different account does not protect the Worker.

## 12.3 Quick start

```bash
git clone https://github.com/<OWNER>/classhub.git && cd classhub && npm ci
cp .env.cloudflare.example .env.cloudflare   # fill CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
npm run setup        # D1, private R2, wrangler.jsonc, migrations, bootstrap admin invite
npm run deploy       # deploys locked
# configure Access + Google with docs/GOOGLE_ACCESS.md, using the values setup printed
npm run preflight    # checks account, bindings, Access, hostnames, bucket privacy, migrations
npm run unlock       # opens the site to approved members
```

- **R-OPS-04** **`npm run setup`** (interactive, idempotent):
  1. checks Node, `.env.cloudflare`, the token's access to the account (`cf.mjs`), and existing `wrangler.jsonc`;
  2. asks the project slug (Worker name), site title, default theme, language and bootstrap admin email;
  3. creates or reuses D1 `<slug>-db` and R2 `<slug>-media` (listing first; never a duplicate, never deleting);
  4. generates the gitignored `wrangler.jsonc` from `wrangler.jsonc.example`: `account_id`, `name`, D1 and R2
     bindings, the `CHAT_ROOM` Durable Object binding with a `new_sqlite_classes` migration, `workers_dev: true`,
     `preview_urls: false`, vars `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` left empty until known;
  5. generates and stores `INTERNAL_CONTEXT_KEY` as a Worker secret (R-CHAT-04) if missing;
  6. applies remote migrations and seeds only `site_settings` defaults and the bootstrap admin invite, never demo
     content and never over existing members;
  7. prints the account id, Worker hostname (`<slug>.<subdomain>.workers.dev`), D1 id, bucket name, admin email and
     the Google redirect URI to use; never a secret.
- **R-OPS-05** `docs/DEPLOY_CLOUDFLARE.md` has a manual fallback for each setup step (dashboard and `wrangler`
  commands through `cf.mjs`).

## 12.4 Access and Google (`docs/GOOGLE_ACCESS.md`)

- **R-OPS-06** The walkthrough, with screenshots, in order:
  1. enable Zero Trust Free **in the deployment's account** and choose a team name;
  2. in Google Cloud Console, configure the OAuth consent screen and create a **Web application** OAuth client;
  3. authorized JavaScript origin `https://<team>.cloudflareaccess.com`;
  4. authorized redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`;
  5. in Zero Trust, add **Google** as a login method with the client id and secret (the secret stays in Cloudflare);
  6. create a **self-hosted** Access application for the exact Worker hostname (and the custom hostname, if any)
     with an **Allow** policy whose include rule lists each approved email;
  7. copy the application's **AUD tag** and the team domain into `.env.cloudflare` (`ACCESS_AUD`,
     `ACCESS_TEAM_DOMAIN`), then `npm run deploy` again to write them into the Worker vars;
  8. test an allowed and a non-allowed Gmail account, then the chat WebSocket; never add Worker-level Access;
  9. disable or protect any other hostname of the Worker (R-AUTH-02).
- **R-OPS-07** The Google consent screen may stay in **Testing** only if every member is added as a test user;
  the guide recommends publishing it (basic scopes `openid email profile` need no Google verification) and says so.

## 12.5 Preflight, unlock and deploy

- **R-OPS-08** **`npm run deploy`** = `npm run build` then `cf.mjs deploy`. It refuses to run when `wrangler.jsonc`'s
  `account_id` differs from `.env.cloudflare`, or when the deployed schema version is ahead of the code.
- **R-OPS-09** **`npm run smoke:test`** loads `/health` and confirms the hostname redirects to Access.
- **R-OPS-10** **`npm run preflight`** checks, each reported pass/fail with the fix:
  account id matches; D1, R2 and DO bindings exist; remote migrations are current (and none destructive is pending
  without a newer verified backup, R-DB-11); `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set and the team JWKS loads;
  every known hostname without a cookie is redirected to `<team>.cloudflareaccess.com` (R-AUTH-02); preview URLs are
  off; the bucket has no public `r2.dev` access and no custom domain (AC-MEM-08); a bootstrap admin is active;
  seats are under 50; a backup exists or the admin is warned none does.
- **R-OPS-11** **`npm run unlock`** runs preflight and sets `setup_state = "unlocked"` only if it passes; `npm run
  lock` sets it back (an emergency switch).
- **R-OPS-12** **Updates:** the docs' update workflow is `git pull --ff-only` → `npm ci` → `npm run backup` (must
  pass) → `npm run db:migrate:remote` → `npm run deploy` → `npm run smoke:test`. `db:migrate:remote` refuses when the
  newest verified backup is older than the last deploy (INV-7). Destructive migrations are never applied silently.
- **R-OPS-13** `/admin` shows the running version and, when a newer GitHub release exists (checked from the admin's
  browser at most daily, against the public releases API only), a banner linking its notes; nothing updates itself.

## 12.6 Local development

See R-PLAT-10. A mocked Access JWT in tests never proves that production Access is configured; that is what
preflight and the manual allowed/denied test are for.

## 12.7 CI/CD

- **R-OPS-14** Pull requests run `npm run verify` and `test:e2e` (R-PLAT-11). Deploy from GitHub Actions
  (`deploy.yml`) is optional and off by default: it runs on a release tag, in a protected environment needing manual
  approval, with an account-scoped token, and runs backup-free steps only (`deploy`, `smoke:test`); migrations stay a
  manual, backed-up step unless the admin opts in.
- **R-OPS-15** Releases use SemVer tags with notes listing breaking changes and migration steps; backup formats are
  versioned under the same policy (§13.1).

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-OPS-01 | `setup` run twice creates one D1, one bucket, keeps members and settings, and prints the same values | R-OPS-04 | integration with fake `wrangler` + manual 1d |
| AC-OPS-02 | A fresh clone deploys to the second account without editing source files | R-OPS-02, 04 | manual 1d, repeated 6b from a clean clone |
| AC-OPS-03 | `deploy` refuses when `wrangler.jsonc` and `.env.cloudflare` name different accounts | R-OPS-08 | unit |
| AC-OPS-04 | `preflight` fails on each broken item of R-OPS-10 (fixture per item) | R-OPS-10 | unit with fakes |
| AC-OPS-05 | `unlock` refuses while preflight fails; `lock` locks immediately | R-OPS-11 | integration |
| AC-OPS-06 | `db:migrate:remote` refuses without a verified backup newer than the last deploy | R-OPS-12 | unit |
| AC-OPS-07 | Following `GOOGLE_ACCESS.md` alone, a second person configures Access and Google for a fresh deployment | R-OPS-06 | manual 6b |
