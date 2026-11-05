# 13 — Backup, restore and leaving Cloudflare

**Covers:** The archive format, the backup, verify and restore CLIs, schedule and retention, disaster recovery, the Node target.
**Read when:** touching `scripts/backup.mjs`, `verify-backup.mjs`, `restore.mjs`, `export-chat.mjs`, importers, or the Node adapters.
**Owns:** `R-BAK-*`, `AC-BAK-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§13.n` is in this file.

---

## 13.1 Archive format

```text
classhub-backup-2026-11-05T000000Z/
├── manifest.json            # format, versions, counts, sizes, hashes, completed flag
├── database.sql             # wrangler d1 export: schema + data (authoritative restore artifact)
├── portable/
│   ├── users.ndjson  profile_contacts.ndjson  invites.ndjson  info_pages.ndjson
│   ├── posts.ndjson  comments.ndjson  albums.ndjson  media.ndjson  chat-messages.ndjson
│   └── settings.json
├── objects/media/v1/…  objects/avatars/v1/…   # byte-for-byte copies
├── checksums.sha256         # every file above, sha256sum format
└── RESTORE.md               # app version and exact restore commands
```

- **R-BAK-01** **SQL is the authoritative restore artifact; NDJSON/JSON is the cross-database interchange.** Both are
  written; neither contains a provider URL, account id or token.
- **R-BAK-02** `manifest.json`: `format: "classhub-backup"`, `formatVersion`, `appVersion`, `schemaVersion`,
  `exportedAt`, `database { path, sha256, bytes }`, per-table row counts, `objects { count, totalBytes }`,
  `completed`. `completed: true` is written last, only after every check of R-BAK-04 passed; a directory without it
  is not a backup.

## 13.2 CLI

- **R-BAK-03** **`npm run backup`** (through `cf.mjs`): takes a lock file (no overlapping runs); exports D1 with
  `wrangler d1 export --remote`; exports each table to NDJSON by reading the SQL dump into a temporary local SQLite
  database (no extra remote reads); copies every R2 object over the S3 API with `rclone copy --checksum` using an R2
  API token kept in the local `rclone` config, or with the built-in S3 client when rclone is absent; writes the
  manifest and checksums.
- **R-BAK-04** **Verification** (`npm run verify-backup -- <dir>`, also run at the end of `backup`): every checksum
  matches; the SQL file parses fully into a fresh SQLite database and its row counts equal the manifest's; every
  non-deleted `media` row's `object_key` and `thumb_key` exist in `objects/` with the recorded size and SHA-256;
  object count and bytes equal the manifest. CLI exit codes alone never count as success.
- **R-BAK-05** **Encryption:** `backup --encrypt` (the default when `age` is installed and a recipient is configured)
  produces `classhub-backup-<ts>.tar.age`; the docs explain keeping the identity key apart from the archive. An
  unencrypted backup prints a warning that it contains members' contact data.
- **R-BAK-06** **`npm run restore -- <dir> --target new`** restores into a **new, empty** D1 database and bucket named
  by flags (it refuses a database with any `users` row), then migrates the schema forward (R-DB-12), copies the
  objects, re-verifies hashes and references, and runs integrity checks (every foreign key resolves; every media row
  has its objects).
- **R-BAK-07** `npm run restore -- <dir> --target local` restores into `data/` for the local adapters, so a backup can
  be opened with `npm run dev:offline` without Cloudflare.
- **R-BAK-08** Restoring into a live site is not supported; disaster recovery always restores side by side (§13.4).
- **R-BAK-09** After a verified backup, the CLI writes a `backup_runs` row (no content) so `/admin` can show the last
  verified backup's date and size, and preflight and `db:migrate:remote` can check it (R-OPS-12).

## 13.3 Schedule and retention

| Frequency | What | Where |
|---|---|---|
| Weekly | SQL + incremental object copy | the admin's computer or external drive |
| Monthly | complete verified, encrypted snapshot | off-provider location |
| Before every upgrade | complete verified snapshot | off-provider location |
| Every 3 months | test restore to `--target local` | local |
| Before chat pruning | verified chat NDJSON archive (R-CHAT-14) | off-provider location |

- **R-BAK-10** The live R2 bucket is never the only backup destination; `rclone copy` is used, never `sync`.
- **R-BAK-11** **Retention:** keep the last 12 weekly and 12 monthly snapshots; `npm run backup -- --prune-old`
  deletes older local snapshots only after the newest one verified. Completed deletion requests age out of backups
  with this schedule (R-PROF-12).
- **R-BAK-12** D1 Time Travel (point-in-time recovery) is a convenience, not a backup.

## 13.4 Disaster recovery

1. Provision a new D1 database and private bucket; leave the old environment untouched.
2. `verify-backup` the archive.
3. `restore --target new`, which imports, migrates, copies and re-verifies.
4. Run the smoke and permission tests against the restored instance.
5. Configure Access for the new hostname and confirm the admin.
6. Cut over the domain only after the restore is tested; revoke old tokens.

## 13.5 Leaving Cloudflare

- **R-BAK-13** **Node target:** `npm run build:node` builds with `adapter-node`; the Node server uses `better-sqlite3`
  (or libSQL), the filesystem or any S3-compatible store for objects, an in-process `ws` hub for `RealtimeHub`, and an
  OIDC identity adapter (Google) behind the same `IdentityProvider` port. Ids, object keys and the schema stay the
  same. `docs/SELF_HOST_NODE.md` walks through it and CI builds it.
- **R-BAK-14** On a new identity provider, accounts are re-linked by verified email on first login, and the admin
  sees which members have not re-linked yet.
- **R-BAK-15** The docs say plainly: portability and zero cost are separate goals; another host may not be free, and
  a `workers.dev` hostname can't move (a custom domain can).

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-BAK-01 | A backup of the demo site restores DB, media, theme settings and chat into a fresh instance with equal counts and hashes | R-BAK-03, 04, 06 | integration (local) + manual 5b against the second account |
| AC-BAK-02 | `verify-backup` fails on a missing image, a truncated SQL file and a mismatched checksum | R-BAK-04 | unit fixtures |
| AC-BAK-03 | A directory without `completed: true` is rejected by restore | R-BAK-02 | unit |
| AC-BAK-04 | `restore --target new` refuses a non-empty database | R-BAK-06 | integration |
| AC-BAK-05 | A backup restored with `--target local` runs under `npm run dev:offline` with no Cloudflare credentials | R-BAK-07, 13 | e2e |
| AC-BAK-06 | Two concurrent `backup` runs: the second exits without writing | R-BAK-03 | unit |
| AC-BAK-07 | The Node build passes the same repository, storage and chat contract tests | R-BAK-13 | `test` (contract) |
| AC-BAK-08 | No archive file contains an account id, token or provider URL | R-BAK-01 | `verify-backup` scan |
