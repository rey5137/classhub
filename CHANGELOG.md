# Changelog

All notable changes to Class Hub are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - unreleased

The first release: one private class site on Cloudflare's free tier, built in phases 0–5.

### Added

- **Platform:** SvelteKit and TypeScript on one Cloudflare Worker, D1 as the only structured store, a private R2
  bucket for media, and a Durable Object used only as chat transport. Provider code stays in adapters, with local
  SQLite/filesystem adapters for development and a demo seed.
- **Identity:** Cloudflare Access JWT verification with the app's own membership check, invites, suspension, the
  setup lock and bootstrap admin, a public opt-in join-request form with Turnstile, one-time email PIN sign-in, an
  optional invite email, and Access External Evaluation so an invite needs no policy edit.
- **Profiles:** a private member directory, per-field contact visibility, normalized contact links, an own-data
  export, profile clearing, and account deletion with keep-or-delete content.
- **Memories:** browser-side photo optimization with EXIF removal, albums, a photo wall and photo pages, a quota
  ledger, an 8 GB warning and a 9 GB upload stop, and private media routes.
- **Discussions:** a sanitized Markdown renderer, threads with one level of comments, pinning and locking, and
  moderation through the same services as the UI.
- **Chat:** one real-time room with persist-before-ack, history paging, reconnects, unread markers, message
  deletion, and verified encrypted archives before pruning.
- **Notifications:** opt-in Web Push per device, per-member kinds, a temporary mute, quiet mode and summaries, and
  installed-app prompts.
- **UI:** three shipped themes (yearbook, minimal, night) with light and dark rules, Vietnamese and English message
  dictionaries, a mobile-first app shell, and an installable app with an offline page.
- **Backups:** mandatory `age` encryption, a portable NDJSON copy beside the SQL dump and every photo, checksums and
  a manifest, `verify-backup`, restore into a new database and bucket or onto a computer, chat archive restore, and
  the last 12 weekly and 12 monthly snapshots.
- **Operations:** `setup`, `deploy`, `preflight`, `unlock`/`lock`, `smoke:test`, a schema guard on deploy, and the
  account guard that refuses any command aimed at another Cloudflare account.
- **Budget:** per-route row-read budgets, keyset paging past 50 rows, D1-failure degradation, and the R2 cost
  guardrails.
