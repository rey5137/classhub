# 13 — Backup, restore and leaving Cloudflare

**Covers:** The archive format, the backup, verify and restore CLIs, schedule and retention, mandatory encryption, disaster recovery, leaving Cloudflare (the production Node target is deferred, §D).
**Read when:** touching `scripts/backup.mjs`, `verify-backup.mjs`, `restore.mjs`, `export-chat.mjs`, `scripts/lib/s3.mjs`, or the local adapters used by `restore --target local`.
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
├── objects/media/v1/…  objects/avatars/v1/…   # byte-for-byte copies, a full copy per snapshot
├── checksums.sha256         # every file above, sha256sum format
└── RESTORE.md               # app version and exact restore commands
```

The directory above is a staging layout in a private temporary directory; the only artifact left on disk is the
encrypted `classhub-backup-<ts>.tar.age` (R-BAK-05).

- **R-BAK-01** **SQL is the authoritative restore artifact; NDJSON/JSON is the cross-database interchange.** Both are
  written; neither contains an account id or token, and no file the backup writes itself contains a provider URL. Each NDJSON line is one row (column names as keys,
  rowid order); `settings.json` is the `site_settings` rows with `value_json` parsed into `value`. Both are written
  from the dump, so `verify-backup` rebuilds them from `database.sql` and compares byte for byte. Every file but the
  photo bytes is scanned for the R2 S3 host, `api.cloudflare.com`, and the account id, API token, R2 keys, Access
  audience and team domain from `.env.cloudflare` (`backup` always has it; `verify-backup` uses it when the machine
  has one and otherwise says the values were not checked). An account id, token, key or Access audience fails
  anywhere. The provider hosts and the team domain fail in the files the backup writes itself (`manifest.json`,
  `RESTORE.md`, `checksums.sha256`, `portable/settings.json`); in `database.sql` and the content NDJSON they are what a
  member or admin wrote (a sign-out link, a how-to page), so there they are a printed warning. Every message names the
  file, and for an NDJSON file the table and the row ids, never the value.
- **R-BAK-02** `manifest.json`: `format: "classhub-backup"`, `formatVersion`, `appVersion`, `schemaVersion`,
  `exportedAt` (D1's clock, the same value as `backup_runs.verified_at`, R-BAK-09; `RESTORE.md` and the snapshot name
  carry it too, never the admin machine's clock), `database { path, sha256, bytes }`, per-table row counts (`tables`,
  from the dump), `liveCounts` (R-BAK-03's live `COUNT(*)` per table), `portable` (each `portable/` path with its row
  count), `objects { count, totalBytes }`, `skipped` (R-BAK-16), `completed`. `completed: true` is written last, only after every check of R-BAK-04 passed; a directory without it
  is not a backup.

## 13.2 CLI

- **R-BAK-03** **`npm run backup`** (through `cf.mjs`): takes the **backup lock** (a lock file shared with
  `export-chat` and `prune-chat`, R-CHAT-14, 18, so none of them overlaps another or itself); reads live `COUNT(*)` for every
  table (R-BAK-04); exports D1 with `wrangler d1 export --remote`; exports each table to NDJSON by reading the SQL dump
  into a temporary local SQLite database (no extra remote reads); lists and copies **every** R2 object, in full, into
  the snapshot over the S3 API with the one built-in S3 client (`scripts/lib/s3.mjs`, R-BAK-17); writes the manifest and
  checksums, then encrypts (R-BAK-05). No `rclone`, no second credential path.
- **R-BAK-04** **Verification** (`npm run verify-backup -- <archive.tar.age|dir>`, also run at the end of `backup`
  on the staged snapshot before encryption; given an archive it decrypts into a private temporary directory with
  `--identity`): every checksum matches; the SQL file parses fully into a fresh SQLite database and its row counts equal
  the manifest's; **the counts read live before the export (R-BAK-03) are `<=` the dump's counts for every table that is
  never hard-deleted (R-DB-13), so a dump truncated at a statement boundary fails**; every non-deleted `media` row's
  `object_key` and `thumb_key` exist in `objects/` with the recorded size and SHA-256; object count and bytes equal the
  manifest (objects with no row, from an upload after the export, are allowed). Objects under `staging/` (R-MEM-12) are never read, copied, counted or checked, by `backup` or by `verify-backup`; only final keys are in the snapshot. Chat archives (R-CHAT-14, 15, 18) are separate encrypted files verified by `export-chat`, not part of the snapshot. CLI exit codes alone never count as
  success.
- **R-BAK-05** **Encryption is mandatory.** `age` is a documented prerequisite (§12.1) and `backup` needs a recipient
  (`--recipient` or `AGE_RECIPIENT`); without `age` or a recipient it refuses to write anything. The output is always
  `classhub-backup-<ts>.tar.age`; staging is a private temporary directory removed on success and on failure; there
  is no `--no-encrypt`. `export-chat` archives are encrypted the same way (R-CHAT-14). The docs explain keeping the
  identity key apart from the archive and off the machine that holds the archive.
- **R-BAK-06** **`npm run restore -- <archive> --target new`** restores into a **new, empty** D1 database and bucket
  named by flags. It refuses a database holding any table (so any row), a **non-empty bucket**, and any database id or
  bucket name equal to the live binding in `wrangler.jsonc`. Order: verify (R-BAK-04); import the SQL, which ends by
  emptying `push_subscriptions` (they belong to the old site's VAPID key and devices; members turn push on again,
  R-NTF-11), clearing `users.access_sub` (the new Access application issues new subjects; accounts re-link by verified email on first login, R-AUTH-25, R-BAK-14) and setting `setup_state='locked'` so `preflight` and `unlock` must run on the new instance before it serves anyone; copy the objects; then re-verify hashes and references and run the integrity checks (every foreign key resolves; every media row has its objects; the counts, the empty `push_subscriptions`, no `access_sub` and the lock) with read-only queries.
  On a database `wrangler.jsonc` does not bind, `scripts/cf.mjs` allows only that one `--file` import while the
  database holds no table, and then only the pinned read-only check statements of `scripts/lib/backup-sql.mjs`.
  The backup's `schemaVersion` must equal the restoring app's; `RESTORE.md` names the app version to check out. Older
  schemas are not migrated in v1.0 (§D); the same-version rule is the whole compatibility contract.
- **R-BAK-07** `npm run restore -- <dir> --target local` restores into `data/` for the local adapters, so a backup can
  be opened with `npm run dev:offline` without Cloudflare. It empties `push_subscriptions` and clears `users.access_sub`
  as R-BAK-06 does but keeps `setup_state` as backed up, so `dev:offline` opens the restored site.
- **R-BAK-08** Restoring into a live site is not supported; disaster recovery always restores side by side (§13.4). The one exception is the insert-only `restore --chat` of R-CHAT-15, which cannot update or delete a row; `export-chat` and `prune-chat` (R-CHAT-14, 18) share the backup lock of R-BAK-03.
- **R-BAK-09** After a verified backup, the CLI writes a `backup_runs` row (no content) so `/admin` can show the last
  verified backup's date and size, and preflight and `db:migrate:remote` can check it (R-OPS-12).
- **R-BAK-16** **Deletion race.** A photo deleted between the SQL export and the object copy does not break
  verification: deleted photos keep their objects for a grace period (`deletedMediaGraceDays` in `site.config.ts`, default 7 days; R-MEM-20) before
  housekeeping purges them, so the object still exists when `backup` copies it. This relies on backups running **at
  least weekly** (§13.3) and on one taking far less than the grace period; a site that raises `deletedMediaGraceDays` only widens the margin.
- **R-BAK-17** **One S3 client.** `scripts/lib/s3.mjs` is the only code that talks to R2's S3 endpoint
  `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`; its R2 S3 credentials come from `.env.cloudflare` through
  the same guard as every other command (R-PLAT-12, INV-9) and are never kept in an `rclone` or other tool config.
  Only `cf.mjs` and `s3.mjs` may name that host or `api.cloudflare.com` (AC-PLAT-07).

## 13.3 Schedule and retention

| Frequency | What | Where |
|---|---|---|
| Weekly (at least; R-BAK-16) | SQL + full object copy, encrypted | the admin's computer or external drive |
| Monthly | complete verified snapshot | off-provider location |
| Before every upgrade | complete verified snapshot (restore it with the app version it names) | off-provider location |
| Every 3 months | test restore to `--target local` | local |
| Before chat pruning | verified chat NDJSON archive (R-CHAT-14) | off-provider location |

- **R-BAK-10** The live R2 bucket is never the only backup destination; the S3 client only reads from the live bucket for a backup and never deletes or syncs (R-BAK-17); `restore --target new` writes only into the new, empty bucket, with its own `R2_RESTORE_*` pair (R-BAK-06).
- **R-BAK-11** **Retention:** keep the last 12 weekly and 12 monthly snapshots (each a full, self-contained copy, so deleting a snapshot is the only way a deleted member's photos age out); `npm run backup -- --prune-old`
  deletes older local snapshots only after the newest one verified: a snapshot stays when it is the newest in one of
  the 12 most recent ISO weeks (UTC) holding a snapshot, or in one of the 12 most recent months that do, so a gap in
  backups never deletes the older ones that cover it; nothing but `classhub-backup-<ts>.tar.age` files in the output
  directory is ever deleted, and never the archive this run wrote. The output directory holds one site's snapshots
  (several sites need their own). A file that cannot be deleted is reported; the rest still go and the run still
  succeeds. Completed deletion requests age out of backups
  with this schedule (R-PROF-12).
- **R-BAK-12** D1 Time Travel (point-in-time recovery) is a convenience, not a backup.

## 13.4 Disaster recovery

1. Provision a new D1 database and private bucket; leave the old environment untouched.
2. `verify-backup` the archive.
3. `restore --target new`, which imports (same schema version only, no migration, R-BAK-06), copies and re-verifies.
4. Run the smoke and permission tests against the restored instance.
5. Run `preflight` and `unlock` on the restored instance (it restores locked, R-BAK-06); configure Access for the new hostname and confirm the admin.
6. Cut over the domain only after the restore is tested; revoke old tokens.

## 13.5 Leaving Cloudflare

- **R-BAK-13** **Deferred past v1.0 (§D):** the production Node server (`adapter-node` build, `ws` hub, OIDC identity
  adapter, `docs/SELF_HOST_NODE.md`). Portability is kept by the ports, the SQL schema, the local adapters (used by
  `dev:offline` and `restore --target local`, R-BAK-07) and the contract suites on both adapters (R-PLAT-06). Ids,
  object keys and the schema stay provider-neutral.
- **R-BAK-14** **Re-linking after a restore is in v1.0.** A restore clears `users.access_sub` and members re-link by verified email on first login (R-AUTH-25); the invites and `users` rows keep their ids. *Deferred with R-BAK-13 (§D):* re-linking onto a different identity provider through an OIDC adapter.
- **R-BAK-15** The docs say plainly: portability and zero cost are separate goals; another host may not be free, and
  a `workers.dev` hostname can't move (a custom domain can).

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-BAK-01 | A backup of the demo site restores DB, media, theme settings and chat into a fresh instance with equal counts and hashes | R-BAK-03, 04, 06 | integration (local) + manual 5b against the second account |
| AC-BAK-02 | `verify-backup` fails on a missing image, a truncated SQL file and a mismatched checksum | R-BAK-04 | unit fixtures |
| AC-BAK-03 | A directory without `completed: true` is rejected by restore | R-BAK-02 | unit |
| AC-BAK-04 | `restore --target new` refuses a non-empty database, a non-empty bucket, and a database or bucket id equal to the live binding; a successful restore leaves `setup_state='locked'` | R-BAK-06 | integration |
| AC-BAK-05 | A backup restored with `--target local` runs under `npm run dev:offline` with no Cloudflare credentials | R-BAK-07 | e2e, run by `npm run verify` in the unit project (`tests/unit/restore.test.ts` spawns `restore` and `dev:offline`) |
| AC-BAK-06 | Two concurrent `backup` runs, or a `backup` and a `prune-chat`: the second exits without writing | R-BAK-03 | unit |
| AC-BAK-07 | *Deferred (§D):* the Node build passing the contract tests; the local adapters pass them under AC-PLAT-03 | R-BAK-13 | n/a |
| AC-BAK-08 | No archive file contains an account id or token, and no file the backup writes itself a provider URL or the team domain (in member content: a warning naming table and row) | R-BAK-01 | `verify-backup` scan |
| AC-BAK-09 | `backup` without `age` or a recipient refuses and writes nothing; every output is `.tar.age`; no plaintext staging remains after success or failure | R-BAK-05 | unit |
| AC-BAK-10 | A dump truncated at a statement boundary fails `verify-backup` against the live counts; a photo deleted between export and copy still verifies | R-BAK-04, 16 | unit fixtures + integration |
| AC-BAK-11 | The S3 client takes its endpoint from `CLOUDFLARE_ACCOUNT_ID` and refuses to run without the guard's environment | R-BAK-17 | unit |
