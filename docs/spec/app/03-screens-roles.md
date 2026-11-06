# 03 — Screens, roles and permissions

**Covers:** Routes and screens, the four member states, the permission matrix, feature flags.
**Read when:** adding or changing a route, a screen, a role check or a feature toggle.
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
| `/admin` | Administration | invites, suspension, info pages, pinned posts, site settings and theme, usage, backup status |
| `/locked` | Setup locked | shown to everyone while `site_settings.setup_state` is not `unlocked` (R-AUTH-12); no data |
| `/denied` | No access | uniform screen for a valid Google account with no active membership (R-AUTH-11) |

- **R-NAV-01** Navigation order and visible sections come from `site.config.ts` and admin feature flags (§10.1). The
  shell is mobile-first: a bottom tab bar under 768 px (Home, Memories, Discussions, Chat, Members), a top bar with the
  rest above it; the profile and admin entries sit in the member menu.
- **R-NAV-02** A route of a disabled feature returns 404 for pages and `feature_disabled` for its API; its data stays
  untouched and comes back when the feature is re-enabled (R-UI-04).
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

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-NAV-01 | Every route in §3.1 renders for an active member on 390 px and 1280 px | R-NAV-01 | e2e |
| AC-NAV-02 | Each permission-matrix row is refused server-side for the role marked "—", through the API, not only hidden | R-NAV-05 | integration `permissions` table test |
| AC-NAV-03 | An `invited` or `suspended` user gets the uniform denial on every page and API | R-NAV-04 | integration |
| AC-NAV-04 | Disabling chat hides it, returns `feature_disabled`, and re-enabling shows the same history | R-NAV-02 | integration |
| AC-NAV-05 | Suspending or demoting the last active admin is refused | R-NAV-06 | unit |
