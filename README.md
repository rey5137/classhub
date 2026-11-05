# Class Hub

A small, private, mobile-first reunion website for one school class: a photo wall, a discussion board, a live chat
room, a private member directory and a simple admin page. Classmates sign in with Google, only invited addresses get
in, and the whole thing runs on Cloudflare's free tier.

> **Status: in design.** The specification and implementation plan are written; the code is being built phase by
> phase. Nothing here is deployable yet.

## What it does

- **Memories:** photos optimized in the browser, organized by album and year, served only to members.
- **Discussions:** threads with one level of comments, pinning and locking.
- **Live chat:** one room, real-time, history kept in the database.
- **Classmates:** a private directory where each member decides who sees each contact field.
- **Admin:** invitations, suspension, info pages, site name, theme and feature toggles, storage usage, backup status.
- **Your data stays yours:** a full backup (SQL + NDJSON + every photo, with checksums) that restores without
  Cloudflare.

## What it needs

- Node.js 24+, npm and Git.
- A Cloudflare account (a dedicated one is recommended) with Workers Free and a Zero Trust Free organization.
- **R2 activated in that account. R2 requires a payment method and bills usage beyond the free allowance.** Class Hub
  warns at 8 GB of photos and stops uploads at 9 GB, but that is an app limit, not a billing cap.
- A Google account to create the OAuth client used by Cloudflare Access (no Google Workspace needed).
- Up to 50 members, admins included (the Zero Trust Free seat limit).

## Documentation

- [`docs/spec/SPEC.md`](docs/spec/SPEC.md): what Class Hub is and the rules it keeps, routed to one file per area.
- [`docs/plan/plan.md`](docs/plan/plan.md): how it is being built, phase by phase.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to work in this repo.

## License

[MIT](LICENSE). Contributors keep the rights to their own content; the repository ships synthetic demo data only.
