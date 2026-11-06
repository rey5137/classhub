# Class Hub — Specification Index

**Class Hub** is a small, private, mobile-first reunion website for one school class or reunion group of about 5–50
invited members: a photo wall, a discussion board, one live chat room, a private member directory and an admin page.
Classmates clone it from a public Git repository, rebrand it, deploy it and maintain it without a server administrator
or a recurring hosting bill, as long as usage stays inside Cloudflare's free allowances.

- **Stack:** SvelteKit + TypeScript (Svelte 5 runes) on one Cloudflare Worker; D1 (SQLite) for every persistent record;
  a private R2 bucket for photos; one SQLite-backed Durable Object for WebSocket transport only; Cloudflare Access with
  Google sign-in in front of the hostname (D1–D6).
- **Portable:** every Cloudflare integration sits behind a port with a local adapter (SQLite file, filesystem, in-process
  WebSocket hub, dev identity), and an encrypted backup is restorable without Cloudflare through `--target local`
  (§2.4, §13); a production Node deployment is deferred (§D).
- **Not here:** a public social network, several classes per deployment, video, originals archive, email notifications,
  full-text search (§1, §D).

> **Provenance.** Written 2026-11-05 from the owner's architecture brief *Class Hub: Open-Source Architecture and
> Deployment Specification v1.0 draft* (not kept in the repo; every rule it set is restated in this spec, which is the
> source of truth). The owner added on the same day: **the reference deployment runs in a second Cloudflare account,
> not the account the owner's other projects use** (§2.6, §12.2, INV-9). Provider limits were taken from the brief as
> checked 2026-11-05 and are revalidated by plan slice 1d (§14).

---

## 0. How to use this spec

`SPEC.md` is the only spec file meant to be read every time: read it once per session before the first task that
writes code or changes the spec. Everything else is loaded on demand. Each child file states in its first six lines
what it covers, when to read it and which ids it owns, so `head -6` decides whether to open it.

### Routing table

| If you are working on… | Read |
|---|---|
| Anything at all | this file: product boundary, locked decisions, invariants |
| Stack, ports and adapters, repo layout, local dev, CI, the Cloudflare account guard | `platform/02` |
| Routes, screens, roles, permission matrix, feature flags | `app/03` |
| Member profiles, contact visibility, directory, self-service export and deletion | `app/04` |
| Tables, ids, timestamps, constraints, indexes, migrations | `data/05` |
| Cloudflare Access, JWT verification, membership, invites, setup lock, CSRF, headers, rate limits | `auth/06` |
| Photo pipeline, upload protocol, object keys, media delivery, storage quota | `features/07` |
| Home, info pages, discussion board, comments, Markdown | `features/08` |
| Live chat, the Durable Object, chat history, retention and archive | `features/09` |
| Admin customization, theme tokens and presets, UI primitives, i18n, accessibility | `app/10` |
| API routes, error shape, service interfaces | `platform/11` |
| Prerequisites, setup wizard, Access + Google setup, deploy, unlock, update, preflight | `ops/12` |
| Backup format, mandatory encryption, backup and restore CLI, schedule, disaster recovery, leaving Cloudflare | `ops/13` |
| Free allowances, guardrails, graceful failure | `platform/14` |
| Push notifications, VAPID, per-device consent, kinds and mute | `features/16` |
| Named risks and trade-offs | `reference/15` |
| Features parked for after v1.0 (incl. production Node server and OIDC adapter, older-schema importers, OpenAPI) | `reference/D` |

How a phase is built, sliced and verified is `docs/plan/plan.md`; each phase's **Read** list names the sections it
needs.

### Identifiers

| Id | Meaning | Defined in |
|---|---|---|
| `INV-n` | invariant every phase keeps; breaking one is an owner decision, never a patch | §1.2 |
| `D1`–`D10` | locked owner decision; changing one needs the owner's explicit approval | §1.1 |
| `R-<AREA>-nn` | binding rule | the owning child file, inline where the rule is stated |
| `AC-<AREA>-nn` | testable acceptance criterion, citing the rules it proves and how | the owning child file, last section |
| `§n`, `§n.m` | spec section. Numbers are global and stable: `§9.3` is in the file whose name starts `09-` | the child file |
| `0a`, `1b`, `4c`, … | plan phase or slice | `docs/plan/plan.md` §4 |

Areas: `PLAT` 02 · `NAV` 03 · `PROF` 04 · `DB` 05 · `AUTH` 06 · `MEM` 07 · `BRD` 08 · `CHAT` 09 · `UI` 10 ·
`API` 11 · `OPS` 12 · `BAK` 13 · `BUD` 14 · `NTF` 16. The `reference/` files own no rules.

Ids are stable: a new rule or criterion takes its area's next free number wherever it sits in the file, and a removed
one's number is never reused (strike it through with the reason). Each child file's header names the ids it **Owns**.

Cite ids, don't restate the spec, in code comments, commit messages, tests and new docs (`R-AUTH-04`, `AC-MEM-07`,
`INV-3`, `D5`). A test that proves an acceptance criterion names its id in the test title.

### Status

**v1.0:** build, in plan order (phases 0–6). **Deferred (§D)** and **not in scope (§1):** do not build, do not
contradict.

---

## 1. Product boundary

- **One private site for one class.** One deployment serves one class or reunion group of up to 50 identities,
  administrators included (the Cloudflare Zero Trust Free seat limit, §14). Multi-tenant hosting is out of scope.
- **Everything is private.** No anonymous read API, public gallery, public member endpoint, public R2 bucket or search
  indexing. The only unauthenticated responses are `/health` (non-identifying), the install manifest and icons (the site name, theme
  colours and icons; R-NAV-07), the opt-in `/join` form (R-AUTH-27; off by
  default) and the Access login itself.
- **Invited email addresses only.** Members sign in through Cloudflare Access with Google or with Access's one-time
  email PIN (for addresses without a Google account); only explicitly approved email addresses get in, and the app
  checks its own membership list as a second layer (§6). No application passwords (R-AUTH-15).
- **Features:** Home with pinned notices and reunion details; Memories (photo wall, albums, years, captions); a
  discussion board with one-level comments; one live chat room; a private member directory with per-field contact
  visibility; an admin page (§3); opt-in push notifications per device, with per-member kinds and a temporary mute (§16).
- **Zero recurring cost under normal small-class use**, not a guaranteed zero bill: R2 needs billing activation,
  overage is billable, and a custom domain costs money. The app warns at 8 GB of media and stops uploads at 9 GB
  (§7.6, §14).
- **The site is a gallery, not the archive of camera originals.** Photos are optimized in the browser before upload;
  originals stay with the uploader (R-MEM-05).
- **Open source.** MIT-licensed application code; the repo ships synthetic demo data only. Real members' data, photos,
  account ids and secrets never enter Git (INV-6).
- **Not in scope:** a public social network, timeline algorithm, email marketing, mobile app, several classes per
  deployment, AI moderation, video, originals, chat attachments, full-text search, paid subscriptions, email
  notifications, a zero-dashboard one-click install (Access and Google OAuth need manual setup, §12.4).

### 1.1 Locked decisions

| Id | Decision | Exit path |
|---|---|---|
| **D1** | SvelteKit + TypeScript, Svelte 5 runes | SvelteKit `adapter-node` |
| **D2** | One Cloudflare Worker serves the UI and the API | a conventional Node process |
| **D3** | D1 is the **only** persistent structured store | `better-sqlite3`, libSQL, later Postgres |
| **D4** | One private R2 Standard bucket for media | any S3-compatible provider or the filesystem |
| **D5** | A Durable Object is **real-time transport only**; chat history lives in D1 | a Node WebSocket server |
| **D6** | Cloudflare Access with a **self-hosted, hostname-based** application and Google as identity provider; never Worker-level Access (it rejects WebSocket upgrades with 403) | the identity adapter swapped for OIDC |
| **D7** | Theming through CSS custom properties and theme packs | themes stay plain CSS |
| **D8** | Full export in standard formats (SQL, NDJSON/JSON, byte copies of objects) | independent import/export tooling |
| **D9** | No external UI component platform in v1.0 | added selectively later |
| **D10** | The local backup CLI is the canonical backup; no promise that a Worker can zip a whole archive | SQL, plain object copies and the restore script work anywhere; backups are always `age`-encrypted (R-BAK-05) |

The exit paths show where the design allows leaving, not what v1.0 ships: the Node server and OIDC adapter are deferred (§D).
A custom domain, if used, shares the one Access application and AUD (R-OPS-16).

### 1.2 Invariants

- **INV-1 Fail closed on identity.** No private data, page data or media leaves the server without a verified Access
  JWT (signature, issuer, audience, expiry) **and** an `active` membership row, except `/health`, the install manifest and icons (R-NAV-07) and, while the `join` setting is on, the `/join` form
  (R-AUTH-27), which carry no member data, media or counts. A missing, forged or unverifiable
  assertion gets the uniform denial (R-AUTH-03, R-AUTH-11). No debug identity header or query exists in a production
  build (R-AUTH-13).
- **INV-2 D1 is the only authoritative store.** The Durable Object keeps connections and ephemeral presence only; no
  chat message, membership or setting is authoritative anywhere but D1 (D3, D5).
- **INV-3 Media stays private.** The bucket has no public domain and no `r2.dev` access; every media byte is served by
  an authorized route; no long-lived storage credential reaches a browser (§7).
- **INV-4 Provider types stay in adapters.** Application services, repositories and routes never import
  `@cloudflare/workers-types`, `D1Database`, `R2Bucket` or Durable Object types; only `src/lib/server/adapters/cloudflare/`
  and the Worker entry do (R-PLAT-03).
- **INV-5 Contact data follows its owner's choice.** A contact field leaves the server only to the audience its owner
  chose; `auth_email` never appears in the directory or another member's profile; contact data never appears in logs,
  audit payloads or ordinary exports (§4).
- **INV-6 No real data in Git.** No member data, photos, backups, OAuth secrets, Cloudflare account ids, tokens or
  `wrangler` state are committed; demo data is synthetic (R-PLAT-09).
- **INV-7 No destructive change without a verified independent backup.** Chat pruning, destructive migrations and
  restores into a live site never run unless a verified backup exists outside the provider (R-CHAT-14, R-OPS-12,
  R-BAK-08).
- **INV-8 Persist before acknowledging.** A chat message is acknowledged and broadcast only after D1 committed it; an
  upload is a photo only after both objects exist and the metadata committed; success is never shown for unpersisted
  data (R-CHAT-06, R-MEM-10).
- **INV-9 Every Cloudflare command targets the configured account.** Deploys, migrations, bucket and Access changes
  run through the account guard against the account id in the gitignored local config, never against whatever account
  a global `wrangler login` points at (R-PLAT-12).

Breaking an invariant or changing D1–D10 is an owner decision recorded in this file; never patch around one.

*Provenance:* the owner approved the D10 exit-path wording (the exit paths show where the design allows leaving, not what v1.0 ships) and the deferral of the production Node target past v1.0 (§D); both were recorded as owner decisions in commit 3061ad2.

*Provenance:* on 2026-11-05 the owner decided that Access's one-time PIN is a second login method beside Google (commit 617249a, R-AUTH-15). D6 names Google as the identity provider; "invited Google accounts only" reads as invited email addresses only, whichever of the two methods proves the address.
