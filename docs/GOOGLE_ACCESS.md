# Cloudflare Access and Google sign-in

Class Hub has no passwords. Cloudflare Access decides who may reach the site (Google sign-in, or a one-time PIN by
email); the app then decides who may see data. This walkthrough sets up Access for a deployment that
[DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md) has already created and deployed (locked).

You need the two values `npm run setup` printed:

- the **Worker hostname**, e.g. `classhub.<your-subdomain>.workers.dev`;
- the **Google redirect URI**, `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` (you choose `<team>` in
  step 1).

Spec: §6 (`docs/spec/auth/06-access-auth.md`) and §12.4 (`docs/spec/ops/12-deploy.md`).

## 1. Zero Trust in the deployment's account

1. Switch the dashboard to the **dedicated Class Hub account** (the one in `.env.cloudflare`). An Access application
   in any other account does not protect the Worker.
2. Open **Zero Trust**, choose the **Free** plan (up to 50 users; confirm the seat count on the plan screen), and pick
   a **team name**. Your team domain is `<team>.cloudflareaccess.com`.
   > screenshot: the Zero Trust plan screen with the Free plan and its user limit
   > screenshot: the team name field (Settings → Custom pages → Team domain)

## 2. The Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com/), with any Google account (no Workspace needed):

1. Create a project (e.g. "Class Hub sign-in").
2. **APIs & Services → OAuth consent screen**: User type **External**; app name "Class Hub"; your email as support and
   developer contact. Scopes: the basic `openid`, `email`, `profile` only.
   - **Publishing status.** In **Testing**, only the Google accounts listed as **test users** can sign in, so you must
     add every member's Gmail there (up to 100). The recommended choice is **Publish app**: the basic scopes need no
     Google verification, and Access plus the app's invite list still decide who gets in.
   > screenshot: the consent screen's publishing status and test users list
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**:
   - **Authorized JavaScript origins:** `https://<team>.cloudflareaccess.com`
   - **Authorized redirect URIs:** `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
4. Copy the **Client ID** and **Client secret**. The secret goes into Cloudflare only (next step); never into
   `.env.cloudflare`, the repo or a chat.
   > screenshot: the OAuth client with its origin and redirect URI

## 3. Login methods: Google and One-time PIN

In Zero Trust → **Settings → Authentication → Login methods**:

1. **Add new → Google**: paste the Client ID and Client secret, save, then **Test**: it should show your email.
2. **Add new → One-time PIN** (R-AUTH-15). An invited address without a Google account then signs in with a code
   emailed to it. The app treats both the same: the verified email is what counts.
   > screenshot: the login methods list showing Google and One-time PIN

## 4. The Access application

In Zero Trust → **Access → Applications → Add an application → Self-hosted**:

1. **Name:** Class Hub. **Session duration:** e.g. 1 month.
2. **Application domain:** the exact Worker hostname from setup (`classhub.<your-subdomain>.workers.dev`), path empty.
   With a custom domain (the fallback in DEPLOY_CLOUDFLARE.md), add it here as a **second domain of the same
   application**, so there is one application and one AUD.
3. **Login methods:** Google and One-time PIN (turn off "accept all available" if other methods exist).
4. **Policy:** Action **Allow**, name "Classmates", **Include → Emails**: your bootstrap admin email, then each invited
   member. `npm run invite -- add <email>` keeps this list in sync for you if you set `ACCESS_POLICY_ID` (and, for a
   policy that belongs to this one application, `ACCESS_APP_ID`) in `.env.cloudflare`; without them it prints the
   exact dashboard step.
   > screenshot: the application's domain and its Allow policy with the email include rule
5. Save, then open the application's **Overview** and copy the **Application Audience (AUD) Tag**.

Never turn on Worker-level Access ("Protect all Workers" or a Workers route rule): it answers WebSocket upgrades with
`403`, which breaks chat.

### The `/health` bypass

`/health` is the one unauthenticated response (it shows `{ ok: true, version }`, nothing about members). So that
`npm run smoke:test` can load it, add a second, path-specific application:

1. **Add an application → Self-hosted**, name "Class Hub health", domain = the Worker hostname, **path `health`**.
2. Policy: Action **Bypass**, Include **Everyone**.

Every other path stays behind the Class Hub application.

## 5. Into the deployment

1. In `.env.cloudflare` set:
   - `ACCESS_TEAM_DOMAIN=<team>` (or `<team>.cloudflareaccess.com`);
   - `ACCESS_AUD=<the AUD tag>`;
   - optionally `ACCESS_POLICY_ID` and `ACCESS_APP_ID` (Access → Applications → Class Hub → Policies; the ids are in
     the URL), for the invite sync.
2. `npm run deploy` again: it writes `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` into the Worker vars. (The policy and
   application ids stay in `.env.cloudflare`; the Worker never needs them.)

## 6. Test it

1. Open the Worker hostname in a private window: the Access screen offers Google and the email PIN.
2. Sign in with the **bootstrap admin** Gmail: you land on `/admin/setup` while the site is locked.
3. A Gmail that is **not** in the policy is stopped by Access ("That account does not have access").
4. Run `npm run preflight`: `access` and `hostnames` pass. Then `npm run unlock`.
5. After unlocking, run the WebSocket probe (DEPLOY_CLOUDFLARE.md section 10) to prove chat's socket passes Access.

## 7. Other hostnames

The Worker must answer only on hostnames this application protects (R-AUTH-02). Preview URLs are off
(`preview_urls: false`). If you add a custom domain, list it in the same application, and either keep `workers.dev`
in it too or turn it off with `"workers_dev": false` in `wrangler.jsonc`. `npm run preflight` checks every hostname
without a cookie and fails on any that is not redirected to your team.
