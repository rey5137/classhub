# Backup and restore

How to back up a Class Hub site, check a backup, and restore it: into a new Cloudflare database and bucket, or onto
your own computer. The rules behind each step are in `docs/spec/ops/13-backup-restore.md` (§13).

Every command here runs from a checkout of Class Hub on the admin's computer. Remote commands go through
`scripts/cf.mjs`, which checks that `.env.cloudflare` and `wrangler.jsonc` name the same Cloudflare account before
anything runs.

## What you need

- `age` 1.x (`brew install age`, or your system's package). Every backup is encrypted; there is no way to turn that
  off (R-BAK-05).
- An age key pair: `age-keygen -o classhub-backup-key.txt`. Give `backup` the public key (`age1…`) with `--recipient`
  or `AGE_RECIPIENT`. Keep the key file (the identity) apart from the archives, and off the drive that holds
  them: whoever has both can read every member's data.
- In `.env.cloudflare`: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and an R2 pair that can read the live bucket,
  `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. A `--target new` restore also needs `R2_RESTORE_ACCESS_KEY_ID` /
  `R2_RESTORE_SECRET_ACCESS_KEY`, an R2 token with **Object Read & Write on the new bucket only** (see below).

## Back up

```sh
npm run backup -- --out /Volumes/Backup/classhub --recipient age1…
```

`backup` takes the backup lock (shared with `export-chat`, `prune-chat` and `restore --chat`), reads every table's row
count live, exports the database, copies every photo in full, checks the whole snapshot, encrypts it and records a
verified `backup_runs` row (shown on `/admin`). The only file it leaves is
`classhub-backup-<time>.tar.age`. The archive holds `manifest.json`, `database.sql` (the restore artifact), a
`portable/` NDJSON copy of every table, `objects/` (the photos), `checksums.sha256` and `RESTORE.md`, which names
the app version to restore with.

Schedule (§13.3): at least weekly, a monthly copy off the computer, one before every upgrade, and a test restore with
`--target local` every three months.

**Retention.** `npm run backup -- --out <dir> --recipient age1… --prune-old` keeps the newest snapshot of each of the
last 12 ISO weeks and of the last 12 months that hold one, and deletes older `classhub-backup-*.tar.age` files in that
directory only after the new backup verified. Nothing else in the directory is touched. Use one directory per site.

## Check a backup

```sh
npm run verify-backup -- /Volumes/Backup/classhub/classhub-backup-<time>.tar.age --identity classhub-backup-key.txt
```

It decrypts into a private temporary directory (removed afterwards), checks every checksum, rebuilds the database from
`database.sql` and compares its row counts with the manifest and with the counts read live before the export,
checks every photo a media row needs, and rebuilds `portable/` from the dump. A directory without
`"completed": true` in its manifest is not a backup and never restores.

## Restore into a new database and bucket (`--target new`)

A restore never writes the live site. It goes side by side, into a database and bucket that are new and empty
(R-BAK-06, R-BAK-08).

1. Check out the Class Hub version the archive's `RESTORE.md` names. The backup's schema version must equal the
   checkout's; restore refuses anything else and does not migrate.
2. Create the new database and bucket in the account `.env.cloudflare` names:

   ```sh
   node scripts/cf.mjs d1 create classhub-restored --update-config=false
   node scripts/cf.mjs r2 bucket create classhub-restored-media --update-config=false
   ```

   `--update-config=false` keeps `wrangler.jsonc` bound to the live site while you restore.

3. In the Cloudflare dashboard, R2 → Manage API tokens, create a token with **Object Read & Write** on
   `classhub-restored-media` only, and put its pair in `.env.cloudflare` as `R2_RESTORE_ACCESS_KEY_ID` and
   `R2_RESTORE_SECRET_ACCESS_KEY`.
4. Restore:

   ```sh
   npm run restore -- classhub-backup-<time>.tar.age --target new \
     --database classhub-restored --bucket classhub-restored-media --identity classhub-backup-key.txt
   ```

What it does, in order:

1. Verifies the archive exactly as `verify-backup` does, then checks the schema version, the applied migrations and
   every table, index and trigger definition against this checkout, that every foreign key in the dump resolves,
   and works out the row counts the new database must hold. Nothing is written unless all of that passes.
2. Refuses the live database (by binding, name or id in `wrangler.jsonc`) and the live bucket, a database that holds
   any table, and a bucket that holds any object.
3. Imports `database.sql`, opened by a guard table that a second import into the same database would fail on, with
   three statements added at its end (then the guard is dropped): empty `push_subscriptions` (they belong to the
   old site's push key and devices), clear `users.access_sub` (the new Access application issues new subjects),
   and set `setup_state` to `locked`. `cf.mjs` lets this one `--file` import reach a database `wrangler.jsonc` does
   not bind only while that database holds no table; after it, only pinned read-only checks.
4. Copies every photo into the new bucket, each PUT signed with its payload hash.
5. Re-verifies: the bucket holds exactly the backup's objects, each read back and hashed; every media row's
   objects are there; every table's row count equals the manifest's (`push_subscriptions`: none); no foreign key
   dangles; no Access subject is left; the site is locked.

If a step after the import fails, the new database and bucket may be partly written. The live site was not touched.
Delete both (or make new ones) and run the restore again.

### After the restore

1. Bind the new database and bucket in `wrangler.jsonc` (`DB` and `MEDIA`) and `npm run deploy`.
2. Configure Access for the new hostname (`docs/GOOGLE_ACCESS.md`).
3. `npm run preflight`, then `npm run unlock`. The restored site serves nobody until then.
4. Sign in as an admin and as a member and check the board, the gallery's photos, the theme and the chat history
   against the old site.
5. Members sign in as before: each account re-links to the new Access subject by its verified email on the first
   login (R-AUTH-25), with no audit event, since the subject was cleared, not changed.
6. Push notifications start off: the restored site holds no subscription. Members who used them turn them on again
   on the notifications screen (R-NTF-11).
7. Re-apply deletions completed since the backup was taken: the restored data still holds those members' contact
   details and content. If the restored data still holds the deletion request, complete it again in `/admin`. If the
   backup was made before the request, no request exists to complete (only the member can file one): suspend the
   account at once and ask the person to request deletion again. Do this before cutting over.
8. Cut over the domain only after the restored site is tested, then revoke the old site's tokens.

## Disaster recovery rehearsal into a second account

The owner rehearses the side-by-side restore in a second Cloudflare account, so the live account is never involved.

1. In a separate checkout at the version `RESTORE.md` names, write a `.env.cloudflare` for the second account
   (its own `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`).
2. `npm run setup` there. It creates that account's own (empty) database and bucket and binds them in
   `wrangler.jsonc`; restore refuses those as the live ones.
3. Create `classhub-restored` and `classhub-restored-media` in the second account and the restore R2 token, as in
   steps 2–3 above.
4. `npm run verify-backup` the archive, then `npm run restore -- <archive> --target new --database
   classhub-restored --bucket classhub-restored-media --identity <key>`.
5. Point `DB` and `MEDIA` in that checkout's `wrangler.jsonc` at the restored pair, `npm run deploy`, configure
   Access for its hostname, `npm run preflight`, `npm run unlock`.
6. Sign in as an admin and a member, both re-linked by email; check the board, the gallery's photos, the theme and the
   chat history against the old site. Then delete the second account's resources.

## Restore onto this computer (`--target local`)

```sh
npm run restore -- classhub-backup-<time>.tar.age --target local --identity classhub-backup-key.txt
CLASSHUB_DEV_MEMBER=<an admin's email> npm run dev:offline
```

`dev:offline` signs you in as the active member `CLASSHUB_DEV_MEMBER` names, on `127.0.0.1` only.

It writes `data/dev.sqlite` and `data/objects/` (or `CLASSHUB_DB` / `CLASSHUB_OBJECTS`), refuses if either already
holds anything (move them aside first), and needs no Cloudflare credentials. It runs the same verification and
re-checks, empties `push_subscriptions` and clears `users.access_sub`, but keeps `setup_state` as backed up, so
`npm run dev:offline` opens the restored site straight away (R-BAK-07). The files are written under temporary names
and moved into place only after they re-verify.

## Restore chat archives (`restore --chat`)

`npm run export-chat` writes verified chat archives (`chat/<from>_<to>.ndjson.age`) before `prune-chat` removes old
messages (R-CHAT-14). To put one archive's messages back into the live site:

```sh
npm run backup -- --out <dir> --recipient age1…    # a verified backup of the current database first
npm run restore -- --chat <dir>/chat/<from>_<to>.ndjson.age --identity classhub-backup-key.txt
```

It refuses unless a verified backup newer than the last deploy exists (the same check as `db:migrate:remote`) and
while another backup, `export-chat`, `prune-chat` or `restore --chat` holds the backup lock. The file must be one
`export-chat` recorded, under its own name, and must match its recorded hash and count. It only inserts messages
that are missing (`ON CONFLICT DO NOTHING`): it never updates or deletes one, and it skips the messages of members
whose deletion request completed (R-PROF-11). A message deleted after its archive was exported is never brought
back: `prune-chat` leaves it in place as an empty tombstone, so its id is already there (R-CHAT-14). It prints counts
only. Running it twice adds nothing the second time.

An archive made before a member's deletion was completed still holds that member's messages until the file is deleted
(no retention period is set for chat archives). Restoring it skips those messages only while the target database still records the completed deletion; after a
restore from an older backup, re-apply the deletions first (step 7 of "After the restore").
