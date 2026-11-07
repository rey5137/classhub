# Leaving Cloudflare

What it takes today to move a Class Hub site off Cloudflare, and what is not built yet. The rules are in
`docs/spec/ops/13-backup-restore.md` (§13.5).

## Portability and zero cost are separate goals

Class Hub is built to run free on Cloudflare's free plans. Being able to leave is a different promise: another host
may not be free, and you may pay for a server, storage or a domain there. A `workers.dev` hostname cannot move with
you; a custom domain can, so use one if you may ever leave (R-BAK-15).

## What works now

Every backup holds everything a site is, in formats that do not depend on Cloudflare (§13.1):

- `database.sql`: a plain SQLite dump of every table, the artifact a restore imports.
- `portable/`: one NDJSON file per table, readable by any tool.
- `objects/`: every photo, under the same keys the site uses, with `checksums.sha256`.

Ids, object keys and the schema are provider-neutral. Every Cloudflare service sits behind a port with a local
adapter (SQLite file, files on disk, a localhost-only sign-in), and both adapters pass the same contract tests
(R-PLAT-06). So a backup restores onto any computer:

```sh
npm run restore -- classhub-backup-<time>.tar.age --target local --identity classhub-backup-key.txt
CLASSHUB_DEV_MEMBER=<an admin's email> npm run dev:offline
```

That opens the whole site, with its posts, photos, theme and chat history, without a Cloudflare account or
credentials (R-BAK-07, AC-BAK-05). Push subscriptions and Access subjects are cleared on the way, since both belong to
the old site. See `docs/BACKUP_RESTORE.md` for the details.

This is a working copy for one person on one computer, signed in by `CLASSHUB_DEV_MEMBER` on `127.0.0.1` only. It is
not a server for members.

## Not built yet

Deferred past v1.0 (R-BAK-13, spec §D):

- A production Node server: an `adapter-node` build, its WebSocket chat hub, and `docs/SELF_HOST_NODE.md`.
- An OIDC identity adapter, so members could sign in through another identity provider instead of Cloudflare Access,
  and re-link to it by verified email (R-BAK-14).

Until those exist, a site that must stay online for its members stays on Cloudflare. If you have to leave, keep the
latest verified backup and its age key: everything in it can be read back with `--target local` and the NDJSON files.
