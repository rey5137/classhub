# 03 — Screens, roles and permissions

**Covers:** Routes and screens, the four member states, the permission matrix, feature flags, the installable app.
**Read when:** adding or changing a route, a screen, a role check, a feature toggle, the manifest or the service worker.
**Owns:** `R-NAV-*`, `AC-NAV-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§3.n` is in this file.

---

## 3.1 Screens

| Route | Screen | v1.0 capabilities |
|---|---|---|
| `/` | Home | welcome, pinned notices, reunion details, newest memories |
| `/memories` | Memories | responsive photo wall, album and year filters (links, keyset "older photos"), caption, uploader, upload, new album, album edit for its creator or an admin |
| `/memories/[id]` | Photo | full optimized photo, caption, uploader, album, year, download, caption/album edit and delete (with a confirm step) for owner/admin |
| `/discussions` | Board | threads by latest activity, pinned first, cursor pagination, new thread |
| `/discussions/[id]` | Thread | post, one-level comments, edit/delete, admin pin/lock |
| `/chat` | Live chat | one room, recent history, online count, older messages, reconnect state |
| `/members` | Classmates | searchable directory of active members |
| `/members/[id]` | Member | name, avatar, short bio, contact fields visible to the viewer; display name only when the owner isn't `active` (R-PROF-13) |
| `/profile` | My profile | names, avatar, contact fields, per-field visibility, my data export, deletion request |
| `/install` | Install the app | the install guide for the viewer's device (R-NAV-10); linked from Home's install card and from `/profile` |
| `/admin` | Administration | invites, suspension, info pages, pinned posts, site settings and theme, usage, backup status |
| `/locked` | Setup locked | shown to everyone while `site_settings.setup_state` is not `unlocked` (R-AUTH-12); no data |
| `/denied` | No access | uniform screen for a valid Google account with no active membership (R-AUTH-11) |

- **R-NAV-01** Navigation order and visible sections come from `site.config.ts` and admin feature flags (§10.1). The
  shell is mobile-first: a bottom tab bar under 768 px (Home, Memories, Discussions, Chat, Members), a top bar with the
  rest above it; the profile and admin entries sit in the member menu.
- **R-NAV-02** A route of a disabled feature returns 404 for pages and `feature_disabled` for its API; its data stays
  untouched and comes back when the feature is re-enabled (R-UI-04). Every page load of the feature checks the flag itself, so
  a client navigation (`__data.json`, where SvelteKit skips the layout's load) is refused too; its API and form posts are refused in the pipeline.
- **R-NAV-03** Every private page loads its data in `+page.server.ts` after the membership check; client-side
  navigation never fetches a private API without the same check (R-PLAT-01).

## 3.2 Member states and roles

- **R-NAV-04** A `users` row has one `status`: `invited` (on the list, never signed in), `active`, `suspended`. Its
  `role` is `member` or `admin`. Only `active` users reach content; `invited` becomes `active` on the first valid
  signed login with that email (R-AUTH-08); `suspended` is denied immediately, including on an open WebSocket
  (R-CHAT-09, R-CHAT-16). Content also stops when the site is locked (R-OPS-11) or the feature is off (R-NAV-02), for open sockets too.
- **R-NAV-05** **Authorization is enforced on the server** by `src/lib/server/auth/permissions.ts`, one function per
  action (`can(member, 'post.delete', post)`); Svelte only hides controls the server would refuse anyway.
- **R-NAV-06** At least one active admin must remain: demoting or suspending the last active admin is refused.

## 3.3 Permission matrix

| Action | member | admin |
|---|---|---|
| Read home, memories, board, chat, directory | ✓ | ✓ |
| Edit own profile, contacts, visibility, avatar | ✓ | ✓ |
| See another member's contact field | if its visibility is `members` | if `members` or `admins` |
| Create thread, comment, chat message, upload photo | ✓ (rate limits, quota) | ✓ |
| Edit/delete own thread, comment, photo, chat message | ✓ | ✓ |
| Edit/delete anyone's content, pin or lock a thread | — | ✓ |
| Create and edit albums | ✓ create; edit own | ✓ |
| Invite, revoke, suspend, reactivate, change role | — | ✓ |
| Edit info pages, site settings, theme, feature flags | — | ✓ |
| See usage, backup and archive status | — | ✓ |
| Export own data | ✓ | ✓ |
| Export everyone's chat or member contacts | — | CLI only (§13) |

## 3.4 Installable app

The site installs to a phone's Home Screen as an app (a PWA). Installing changes nothing about access: every request
still goes through Access and the membership check, and nothing private is stored on the device. The one exception
is the manifest and its icons, which are public (owner decision 2026-11-06: the site name may be public) so that
Android can build a real installed app.

- **R-NAV-07** **Manifest.** `GET /manifest.webmanifest` (`application/manifest+json`, `Cache-Control: private,
  no-store`) is public: it and `/icons/` sit in an Access Bypass application (like
  `/health`, created by the same deploy step) and skip the identity and membership check, so Android's WebAPK service
  can fetch them. It carries only `id`, `start_url` and `scope` `/`, `display: standalone`, `name` the site name
  (R-UI-01), `short_name` the Level B `shortName` or else the site name, `lang` the default language, and
  `theme_color`/`background_color` from the active theme's registry entry (`src/lib/themes/registry.ts`), and the
  icons: never a member, a count or another setting. Icons are
  Level B static files (`static/icons/`: 192 and 512 px `any`, 512 px `maskable`, a 180 px `apple-touch-icon`),
  shipped as a default set drawn from `favicon.svg` and replaced by a forker; the admin-uploaded logo (R-UI-01) isn't
  used for install icons in v1. Every page head links it (no `crossorigin` attribute needed) and carries `theme-color`, `apple-touch-icon`, `apple-mobile-web-app-title` and
  `mobile-web-app-capable`.
- **R-NAV-08** **Service worker.** `src/service-worker.ts` (SvelteKit's built-in registration) precaches only a
  static, bilingual (vi and en, no member data, its own stylesheet, no inline style) `static/offline.html` and the
  icons, in a cache named with the build version; `activate` deletes every older cache. Every request goes to the
  network. Only when a **navigation** fails with a network error does it answer with the offline page; an HTTP
  response of any status, a redirect to the Access login included, is passed through untouched, so an expired Access
  session always reaches the login. It never caches another response, never handles non-GET, `/api/`, WebSocket or
  cross-origin requests, and has no push, sync or periodic handlers (push is §D).
- **R-NAV-09** **Device detection.** One pure function (`src/lib/install/detect.ts`) maps the user agent,
  `maxTouchPoints`, the standalone state and whether a `beforeinstallprompt` event was captured to one kind:
  `installed` (`display-mode: standalone`, `fullscreen` or `minimal-ui`, or `navigator.standalone`), `in-app` (Zalo,
  Facebook, Messenger, Instagram or LINE in-app browsers, checked before everything below), `prompt` (a captured
  `beforeinstallprompt`), `ios` (iPhone, iPod, iPad, or a Mac user agent with touch points: Safari and the other iOS
  browsers share the Share sheet), `android-menu` (Android without a prompt: Firefox, Samsung Internet, Chrome before
  the event), `desktop-menu` (Safari on macOS: File → Add to Dock; desktop Chromium without a prompt: the address-bar
  install icon) or `unsupported` (everything else, Firefox desktop included).
- **R-NAV-10** **Install guide.** `/install` shows the steps for the detected kind and, under a disclosure, the steps
  for the other kinds: `prompt` an Install button that calls the captured event's `prompt()`; `ios` Share → Add to
  Home Screen; `android-menu` the browser menu → Install app / Add to Home screen; `in-app` "open this page in Safari"
  (iOS) or "in Chrome" (Android) through the in-app browser's menu, plus a Copy link button (Clipboard API, falling
  back to a selected read-only field); `desktop-menu` its menu step; `installed` "already installed". `ios` and
  in-app on iOS add: the Home Screen app signs in separately from Safari, so sign in once more the first time it
  opens. `/profile` always links to `/install`. All copy is in both dictionaries (R-UI-10) except `offline.html`.
- **R-NAV-11** **Home card.** Home shows a dismissible install card, rendered on the client after hydration, when the
  kind is `prompt`, or is `ios`, `android-menu` or `in-app` on a coarse pointer; never for `installed`,
  `desktop-menu` or `unsupported`. It holds one line, the Install button (`prompt`) or a link to `/install`, and a
  dismiss control. Dismissing stores the time in `localStorage` (`classhub:install-card-dismissed`) and hides the
  card for 30 days; an accepted `prompt()` hides it for good on that device. Nothing about installing is sent to the
  server or stored in D1.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-NAV-01 | Every route in §3.1 renders for an active member on 390 px and 1280 px | R-NAV-01 | e2e |
| AC-NAV-02 | Each permission-matrix row is refused server-side for the role marked "—", through the API, not only hidden | R-NAV-05 | integration `permissions` table test |
| AC-NAV-03 | An `invited` or `suspended` user gets the uniform denial on every page and API | R-NAV-04 | integration |
| AC-NAV-04 | Disabling chat hides it, returns `feature_disabled`, and re-enabling shows the same history | R-NAV-02 | integration |
| AC-NAV-05 | Suspending or demoting the last active admin is refused | R-NAV-06 | unit |
| AC-NAV-06 | Without any identity, the manifest returns exactly the R-NAV-07 fields and the icons load; every page links it; nothing else under the Bypass paths answers without identity | R-NAV-07 | integration (security route sweep); e2e head check |
| AC-NAV-07 | In Chromium, after one visit, an offline navigation shows the offline page, an online one shows live data, and Cache Storage holds only the offline page and icons; a redirecting navigation is passed through | R-NAV-08 | e2e (`context.setOffline`); unit for the fetch handler |
| AC-NAV-08 | The detection table maps each fixture user agent (iPhone Safari and Chrome, iPad desktop UA, Android Chrome, Firefox and Samsung, Zalo, Messenger and Facebook on iOS and Android, desktop Chrome, Safari and Firefox, standalone) to its kind | R-NAV-09 | unit |
| AC-NAV-09 | At 390 px the Home card shows; dismissing hides it across reloads until 30 days pass; a stubbed `beforeinstallprompt` shows the Install button and calls `prompt()`; standalone and desktop show no card; `/install` and the `/profile` link render | R-NAV-10, 11 | e2e |
| AC-NAV-10 | On the live site through Access, Android Chrome installs the app (no Chrome badge on the icon) and iOS Safari adds it to the Home Screen; each opens standalone, signs in and reaches chat | R-NAV-07, 08, 10 | manual (plan 4e checklist) |
