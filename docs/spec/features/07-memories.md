# 07 — Memories: the private photo pipeline

**Covers:** Browser image preparation, the upload protocol, object keys, avatars, albums, media delivery and caching, the storage quota.
**Read when:** touching uploads, the gallery, avatars, the `ObjectStorage` port, media routes or quota code.
**Owns:** `R-MEM-*`, `AC-MEM-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§7.n` is in this file.

---

## 7.1 Browser preparation

- **R-MEM-01** Accepted inputs: JPEG, PNG, WebP, and HEIC/HEIF **only when the browser can decode it**
  (`createImageBitmap` succeeds); anything else is refused with a localized reason before upload. Every accepted
  input, PNG included, is re-encoded on the client to WebP or JPEG (R-MEM-02) before upload, so the server accepts
  only `image/webp` and `image/jpeg` (R-MEM-08).
- **R-MEM-02** The browser decodes with EXIF orientation applied (`imageOrientation: 'from-image'`), scales to a
  longest edge ≤ 2000 px and encodes **WebP** at quality 0.82 (JPEG at 0.82 where WebP encoding is unavailable), plus
  a thumbnail with longest edge ≤ 480 px at quality 0.75. Re-encoding drops EXIF, GPS and other metadata.
- **R-MEM-03** **Size target:** image + thumbnail ≤ 2 MB. If larger, the encoder steps quality down to 0.70, then the
  long edge to 1600 px; still larger is refused with an explanation.
- **R-MEM-04** Encoding runs off the main thread (`OffscreenCanvas` in a worker where supported) and shows progress;
  the upload preview shows exactly the version that will be stored.
- **R-MEM-05** The upload screen says that Class Hub keeps an optimized copy and the uploader should keep the
  original.

## 7.2 Upload protocol

- **R-MEM-06** `POST /api/v1/media/reservations { purpose: "photo"|"avatar"|"site", imageBytes, thumbBytes, sha256,
  thumbSha256, mimeType, width, height }` checks membership, rate limits (R-MEM-13), byte limits and the quota, then
  in one batch creates an `open` reservation (new `media_id`, `sha256`, `thumb_sha256`, `mime_type`, `image_bytes`,
  `thumb_bytes`, `width`, `height` (integers 1–20000, copied to `media` at complete), staging keys per R-MEM-12) and adds its bytes to `reserved_bytes`, expiring in 15 minutes, using the
  batch-safe form of R-MEM-19. Over the stop threshold it returns `507 storage_full` (R-MEM-15). The `site` purpose
  (logo, favicon, banner; R-UI-01) is admin-only: any other caller gets the uniform denial. The database enforces the
  three purposes with a `CHECK` on `upload_reservations.purpose`. The size limit is `uploads.maxImageBytes` in
  `site.config.ts`, at most 25 MB (the R2 adapter streams a body over 5 MiB as multipart parts, holding at most one
  part in memory, R-API-07).
- **R-MEM-07** `PUT /api/v1/media/reservations/:id/image` and `.../thumb` stream the body to R2 through the native
  binding while counting bytes and hashing; the stream is aborted the moment it passes the reserved size. **Before
  writing** the route requires `owner_id = caller`, `state = 'open'` and `expires_at > now` (anything else is refused
  with a `409` (wrong state or expired) or the uniform denial (not the owner) and writes nothing), and it writes only to the reservation's **staging key**
  (§7.3), never to the final key of a media row. A stale or repeated `PUT` therefore can only overwrite that
  reservation's own staging object, which `complete` ignores once the state has left `open`. No presigned URL or S3
  credential is issued (INV-3).
- **R-MEM-08** **Validation during upload:** the declared `Content-Type` must be `image/webp` or `image/jpeg`; the
  first bytes must match that type's signature (`RIFF....WEBP`, `FF D8 FF`); the final byte count and SHA-256 must
  equal the reservation's. Any mismatch deletes the staging object and fails the variant. `complete` re-checks both (R-MEM-09), so the `PUT`
  check is an early refusal, not the only one.
- **R-MEM-09** `POST /api/v1/media/reservations/:id/complete { caption?, albumId?, takenYear? }` checks both staging
  objects exist with the recorded size, copies each (stream read, write) to its final key (§7.3) while hashing, and
  refuses on a SHA-256 mismatch; then runs the guarded `complete` transition of R-MEM-21 in one batch (reservation
  `open → completed`, `media` row insert, bytes moved from `reserved_bytes` to `committed_bytes`). Staging objects are
  deleted afterwards (best effort; housekeeping sweeps `staging/` keys of non-open reservations).
- **R-MEM-10** A photo exists only after `complete` committed (INV-8). On any failure the client calls `DELETE
  /api/v1/media/reservations/:id`, which runs the guarded `release` transition of R-MEM-21 and deletes the staging objects.
- **R-MEM-11** **Housekeeping** (`JobRunner`, at most hourly when triggered by traffic, plus `npm run housekeeping`):
  the in-request run takes its slot with a conditional `UPDATE schema_meta SET value = ? WHERE key =
  'housekeeping_last_run_at' AND CAST(value AS INTEGER) < ?` and proceeds only if it changed a row (two concurrent
  requests cannot both run). It releases **at most 20** expired reservations (R-MEM-21), deletes their staging
  objects, retires orphan avatars (R-MEM-13) and finishes one flagged album year-rewrite chunk (R-MEM-14), both traffic runs only, and purges at most 20 deleted photos past the grace
  period (R-MEM-20); the rest wait for the next run. The
  **reconcile is CLI-only** (`npm run housekeeping -- --reconcile`, weekly by the operator; it does not fit the
  Workers Free CPU and subrequest limits): it lists the bucket, deletes objects under `media/`, `avatars/` and
  `staging/` that have no live row and no open reservation, treating a soft-deleted row **past its grace period or
  with `purged_at` set** as no row, and resets `committed_bytes` to the listed total of the kept objects outside `staging/`,
  recording `last_reconciled_at`. Final keys encode the media id (R-MEM-12), so it looks rows up by primary key in
  chunks of 90 listed objects (D1's 100-parameter limit) and compares the keys itself; one statement spawns one
  `cf.mjs d1-query` process, with a 250 ms pause between them. The finals an open reservation's `complete` has
  already copied are kept but **not added to the total** (their bytes are still in `reserved_bytes`). A key under
  `media/` or `avatars/` that is not a final key is **kept and counted**, and listed as `unrecognised object kept`.
  **Precedence of the two ledgers:** the REST path has no atomic batch, so each CLI run starts by rebuilding
  `reserved_bytes` from the open reservations, and rebuilds `committed_bytes` from the live rows **only while
  `last_reconciled_at` is null**. After the first reconcile the bucket total is authoritative: a plain run leaves
  `committed_bytes` alone, and a CLI purge subtracts exactly the rows it flipped (clamped at 0), so a retry never
  subtracts twice. A crash between the row update and that subtraction leaves an overcount (the quota looks fuller,
  never emptier) until the next reconcile. The CLI uses bucket-scoped Object Read & Write credentials
  `R2_HOUSEKEEPING_ACCESS_KEY_ID` / `R2_HOUSEKEEPING_SECRET_ACCESS_KEY`; backup credentials stay read-only.

## 7.3 Object keys

- **R-MEM-12** Keys are relative, opaque and immutable. **Staging:**
  `staging/v1/{reservation-id}/image.webp` and `.../thumb.webp` (`.jpg` when JPEG), the only keys an upload `PUT`
  writes. **Final:** `media/v1/{media-id}/image.webp` · `media/v1/{media-id}/thumb.webp` (also for `site` media, which is never listed in the gallery) · `avatars/v1/{user-id}/{media-id}.webp`
  (`.jpg` when JPEG), written only by `complete`. The database stores keys, never URLs. Replacing a photo or avatar writes a new key; the old
  objects are deleted after the new row committed.

## 7.4 Albums, avatars, deletion and limits

- **R-MEM-13** Per member: 25 photos per day, 2 concurrent open reservations; avatar uploads count against the quota
  but not the daily photo limit. Avatars are one 512 px square (the browser crops) with no separate thumbnail, and a
  reservation for one is refused (`400 validation`) above 1 MB (1,048,576 bytes). The daily count is **reservations in
  a rolling 24 hours, released ones included**, not completed photos. A refusal is `429 rate_limited` with
  `error.reason` `daily` or `concurrent` and its own localized sentence; when both limits are hit it is `concurrent`.
  `Retry-After` for `concurrent` is the soonest open reservation's `expires_at` minus now (at least 1, at most 900
  seconds); for `daily` it is 900. Traffic housekeeping (R-MEM-11) soft-deletes up to 20 live avatar rows older than
  one hour that are no member's current `avatar_media_id` (a `complete` whose `PATCH /me` never followed); R-MEM-20
  purges them after the grace period. The CLI run does not do this.
- **R-MEM-14** Albums have a name (1–80), an optional year tag (four digits) and description (≤ 500). The gallery
  filters by album and by year, newest first, 30 per page, keyset paged. The year is the stored
  `media.effective_year` (album year tag, else the photo's `taken_year`), set when the photo is completed or moved to
  another album and rewritten for the album's photos when an album's year tag changes (R-DB-06): the album row and
  the first ≤ 500 stale photos in one batch, then further chunks of ≤ 500 in the same request until none remain,
  capped at 20,000 rows per request (R-BUD-08). Each chunk selects only stale rows (`album_id = ? AND deleted_at IS
  NULL AND effective_year IS NOT <new value>`), so a retry or the next PATCH finishes an interrupted rewrite. The PATCH also adds its album id to the
  `schema_meta` value `year_rewrite_pending` (`,id,id,`, no duplicates) in the album batch. While the key lists an
  album, each traffic housekeeping run (R-MEM-11) rewrites one chunk of ≤ 500 stale live photos of the first listed
  album only, through `media_album_idx` (one stale-year predicate shared with the PATCH, so no scan of other albums'
  photos), and removes that id in the same batch once no stale photo remains; the key is deleted when the list is
  empty. Only the housekeeping run removes an id, as the same album may be PATCHed again meanwhile. A value that is
  not a `,id,…,` list is deleted with no work. Without the key the run does nothing, so no hourly scan of `media`.
  Captions are plain text ≤ 500 characters.
- **R-MEM-20** Deleting a photo (owner or admin) sets `deleted_at`, removes it from every view and from
  `/api/v1/media/:id/*` at once, and **keeps its objects for a grace period**: `deletedMediaGraceDays` in
  `site.config.ts` (integer 1–90, default **7**). Housekeeping or the CLI then purges it: delete the objects (idempotent),
  then in one batch subtract the row's `size_bytes + thumb_size_bytes` from `committed_bytes` (statement first) and set
  `purged_at` (`WHERE purged_at IS NULL`), so bytes are subtracted once, at purge time. If the D1 write succeeded
  and an R2 delete failed, the row stays unpurged and the next run retries. A restore UI for deleted photos is
  deferred past v1.0 (the grace only protects backups, R-BAK-16, and mistakes handled by the CLI). Board posts may reference a photo by id; a deleted photo
  renders as a *photo removed* placeholder.

## 7.5 Delivery and caching

- **R-MEM-16** `GET /api/v1/media/:id/:variant` (`image`, `thumb`; avatars through `/api/v1/media/:id/image`) verifies
  identity and membership, that the row exists and isn't deleted, then streams the object from R2. An `avatar` row is
  served only while it is its owner's current `avatar_media_id` **and** `projectProfile(viewer, owner)` shows it to this
  viewer (R-PROF-02/03/13); otherwise the answer is the same `not_found` as an unknown id, also for a revalidation that
  would have been a `304`. Because avatars are `private, max-age=300` (R-MEM-17), a browser that already holds one can
  keep showing it for up to five minutes after the owner hides or changes it. The bucket has no
  custom domain and `r2.dev` stays disabled (INV-3).
- **R-MEM-17** Response headers: `Cache-Control: private, max-age=300` for thumbnails and avatars, `private, no-cache`
  for full images; `ETag` from the stored SHA-256 with `If-None-Match` → `304`; `Content-Type` from the row;
  `Content-Disposition: inline` only for the two allowed image types; `X-Content-Type-Options: nosniff`. No shared
  CDN caching of member media.

## 7.6 Quota

- **R-MEM-15** **Budget:** usage = `committed_bytes + reserved_bytes`, covering images, thumbnails, avatars and open
  uploads. At `mediaWarnBytes` (default 8 GB) admins see a banner on every page and the usage screen turns amber; at
  `mediaStopBytes` (default 9 GB) new reservations are refused and members see *uploads are paused*; browsing keeps
  working. Both thresholds are in `site.config.ts`, may only be lowered from `/admin`, and can never exceed 9.5 GB.
- **R-MEM-18** `/admin` usage shows committed and reserved bytes, photo count, last reconcile, the R2 operation
  estimate (Class A puts and lists written per request, a multipart put counted as its create, each part and its
  complete, exact unless that write fails; Class B reads tallied per isolate and written at most once a minute, so a
  lost isolate undercounts; deletes and multipart aborts are not billed and not counted; operations made by the CLI, backup, housekeeping
  and reconcile, are not counted either, so the estimate is a floor)
  and a link to the account's R2 dashboard, and states that
  the app's cap is not a billing cap (§14).
- **R-MEM-19** Concurrent reservations can't overshoot, in a form a D1 batch can run (a batch cannot branch on an
  earlier statement's result): `INSERT INTO upload_reservations (…) SELECT … WHERE (SELECT committed_bytes +
  reserved_bytes FROM storage_usage WHERE singleton_id = 1) + ? <= ?` (the same `WHERE` also holds the 2-open-
  reservations limit of R-MEM-13), then `UPDATE storage_usage SET reserved_bytes = reserved_bytes + ? WHERE
  singleton_id = 1 AND EXISTS (SELECT 1 FROM upload_reservations WHERE id = ?)`. The route returns `507` when the
  insert changed no row.

## 7.7 Reservation state machine

- **R-MEM-21** A reservation is `open → completed | released`, no other transition (`uploaded` does not exist; the
  `PUT` verifies and the state stays `open`). Each transition is a guarded `UPDATE` that stamps a fresh
  `state_run_id` (a UUID per call), and every later statement of the same batch is conditioned on `EXISTS (… WHERE
  id = ? AND state = <new state> AND state_run_id = ?)` so a repeated or racing call changes nothing:
  - `complete`: `UPDATE … SET state='completed', state_run_id=? WHERE id=? AND owner_id=? AND state='open' AND
    expires_at > ?`, then the `media` insert and the `reserved_bytes → committed_bytes` move, each guarded by the
    `EXISTS` above.
  - `release` (client `DELETE`, or housekeeping): `UPDATE … SET state='released', state_run_id=? WHERE state='open'
    AND (id = ? AND owner_id = ?` or `id IN (<≤ 20 expired ids>))`, then `UPDATE storage_usage SET reserved_bytes =
    reserved_bytes - (SELECT COALESCE(SUM(reserved_bytes), 0) FROM upload_reservations WHERE state_run_id = ?)`.
    Housekeeping therefore subtracts only the rows **this run** released, never rows `complete` or another run touched.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-MEM-01 | A 12 MP JPEG with GPS EXIF becomes a ≤ 2000 px WebP + ≤ 480 px thumb, ≤ 2 MB combined, with no EXIF/GPS | R-MEM-02, 03 | e2e (Chromium + WebKit) + byte inspection |
| AC-MEM-02 | An unsupported file and an undecodable HEIC are refused before any request | R-MEM-01 | e2e |
| AC-MEM-03 | Upload, view, filter by album and year, and delete work end to end | R-MEM-06…10, 14, 20 | e2e |
| AC-MEM-04 | A PNG body declared `image/webp`, a body larger than reserved, and a hash mismatch are each refused and leave no object | R-MEM-08 | integration (R2 pool) |
| AC-MEM-05 | Twenty parallel reservations near the stop threshold never take usage past it | R-MEM-19 | integration |
| AC-MEM-06 | At 9 GB reservations return `507`; at 8 GB admins see the warning; members can still browse | R-MEM-15 | integration with a seeded counter |
| AC-MEM-07 | A media URL copied into a session without Access, or by a suspended member, returns the uniform denial; an avatar's bytes follow the owner's current avatar and its visibility | R-MEM-16 | `test:security` |
| AC-MEM-08 | The bucket has no public access and no custom domain | R-MEM-16 | `preflight` (R-OPS-10) |
| AC-MEM-09 | Expired reservations are released and orphan objects removed; the counter matches the bucket after reconcile | R-MEM-11 | integration |
| AC-MEM-10 | Media responses carry the R-MEM-17 headers and answer `If-None-Match` with `304` | R-MEM-17 | integration |
| AC-MEM-11 | A `PUT` by another member, or to a completed, released or expired reservation, is refused, and the stored object (staging and final) is byte-identical afterwards | R-MEM-07, 21 | integration (R2 pool) |
| AC-MEM-12 | `complete` called twice, `complete` racing the housekeeping release, and `DELETE` after `complete` each leave `reserved_bytes`/`committed_bytes` consistent (never negative, never double counted) and one `media` row at most | R-MEM-09, 19, 21 | integration |
| AC-MEM-13 | A deleted photo vanishes from every view and from media URLs at once, keeps its objects and counted bytes for `deletedMediaGraceDays`, then is purged with bytes subtracted once; a failed R2 delete is retried next run | R-MEM-20 | integration (clock control) |
