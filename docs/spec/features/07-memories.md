# 07 — Memories: the private photo pipeline

**Covers:** Browser image preparation, the upload protocol, object keys, avatars, albums, media delivery and caching, the storage quota.
**Read when:** touching uploads, the gallery, avatars, the `ObjectStorage` port, media routes or quota code.
**Owns:** `R-MEM-*`, `AC-MEM-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§7.n` is in this file.

---

## 7.1 Browser preparation

- **R-MEM-01** Accepted inputs: JPEG, PNG, WebP, and HEIC/HEIF **only when the browser can decode it**
  (`createImageBitmap` succeeds); anything else is refused with a localized reason before upload.
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

- **R-MEM-06** `POST /api/v1/media/reservations { purpose: "photo"|"avatar", imageBytes, thumbBytes, sha256,
  thumbSha256, mimeType, width, height }` checks membership, rate limits (R-MEM-13), byte limits and the quota, then
  in one batch adds `reserved_bytes` to `storage_usage` and creates an `open` reservation with a new `media_id`,
  expiring in 15 minutes. Over the stop threshold it returns `507 storage_full` (R-MEM-15).
- **R-MEM-07** `PUT /api/v1/media/reservations/:id/image` and `.../thumb` stream the body to R2 through the native
  binding at the final key (§7.3) while counting bytes and hashing; the stream is aborted the moment it passes the
  reserved size. No presigned URL or S3 credential is issued (INV-3).
- **R-MEM-08** **Validation during upload:** the declared `Content-Type` must be `image/webp` or `image/jpeg`; the
  first bytes must match that type's signature (`RIFF....WEBP`, `FF D8 FF`); the final byte count and SHA-256 must
  equal the reservation's. Any mismatch deletes the object and fails the variant.
- **R-MEM-09** `POST /api/v1/media/reservations/:id/complete { caption?, albumId?, takenYear? }` checks both objects
  exist with the recorded size, then in one batch inserts the `media` row, moves the reservation's bytes from
  `reserved_bytes` to `committed_bytes`, and marks it `completed`.
- **R-MEM-10** A photo exists only after `complete` committed (INV-8). On any failure the client calls `DELETE
  /api/v1/media/reservations/:id`, which deletes written objects and releases the bytes.
- **R-MEM-11** **Housekeeping** (`JobRunner`, at most hourly when triggered by traffic, plus `npm run housekeeping`):
  expired reservations are released and their objects deleted; a weekly reconcile lists the bucket, deletes objects
  under `media/`/`avatars/` with no row and no open reservation, and resets `committed_bytes` to the listed total,
  recording `last_reconciled_at`.

## 7.3 Object keys

- **R-MEM-12** Keys are relative, opaque and immutable:
  `media/v1/{media-id}/image.webp` · `media/v1/{media-id}/thumb.webp` · `avatars/v1/{user-id}/{media-id}.webp`
  (`.jpg` when JPEG). The database stores keys, never URLs. Replacing a photo or avatar writes a new key; the old
  objects are deleted after the new row committed.

## 7.4 Albums, avatars, deletion and limits

- **R-MEM-13** Per member: 25 photos per day, 2 concurrent open reservations; avatar uploads count against the quota
  but not the daily photo limit. Avatars are one 512 px square (the browser crops) with no separate thumbnail.
- **R-MEM-14** Albums have a name (1–80), an optional year tag (four digits) and description (≤ 500). The gallery
  filters by album and by year (album year, else the photo's `taken_year`), newest first, 30 per page, keyset paged.
  Captions are plain text ≤ 500 characters.
- **R-MEM-20** Deleting a photo (owner or admin) sets `deleted_at`, removes it from every view at once, deletes its
  objects and subtracts its bytes from `committed_bytes`. Board posts may reference a photo by id; a deleted photo
  renders as a *photo removed* placeholder.

## 7.5 Delivery and caching

- **R-MEM-16** `GET /api/v1/media/:id/:variant` (`image`, `thumb`; avatars through `/api/v1/media/:id/image`) verifies
  identity and membership, that the row exists and isn't deleted, then streams the object from R2. The bucket has no
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
  estimate (writes and reads counted by the app per month) and a link to the account's R2 dashboard, and states that
  the app's cap is not a billing cap (§14).
- **R-MEM-19** Concurrent reservations can't overshoot: the reservation's quota check and increment happen in one
  conditional `UPDATE storage_usage SET reserved_bytes = reserved_bytes + ? WHERE committed_bytes + reserved_bytes + ?
  <= ?`, and a reservation is created only if that update changed a row.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-MEM-01 | A 12 MP JPEG with GPS EXIF becomes a ≤ 2000 px WebP + ≤ 480 px thumb, ≤ 2 MB combined, with no EXIF/GPS | R-MEM-02, 03 | e2e (Chromium + WebKit) + byte inspection |
| AC-MEM-02 | An unsupported file and an undecodable HEIC are refused before any request | R-MEM-01 | e2e |
| AC-MEM-03 | Upload, view, filter by album and year, and delete work end to end | R-MEM-06…10, 14, 20 | e2e |
| AC-MEM-04 | A PNG body declared `image/webp`, a body larger than reserved, and a hash mismatch are each refused and leave no object | R-MEM-08 | integration (R2 pool) |
| AC-MEM-05 | Twenty parallel reservations near the stop threshold never take usage past it | R-MEM-19 | integration |
| AC-MEM-06 | At 9 GB reservations return `507`; at 8 GB admins see the warning; members can still browse | R-MEM-15 | integration with a seeded counter |
| AC-MEM-07 | A media URL copied into a session without Access, or by a suspended member, returns the uniform denial | R-MEM-16 | `test:security` |
| AC-MEM-08 | The bucket has no public access and no custom domain | R-MEM-16 | `preflight` (R-OPS-10) |
| AC-MEM-09 | Expired reservations are released and orphan objects removed; the counter matches the bucket after reconcile | R-MEM-11 | integration |
| AC-MEM-10 | Media responses carry the R-MEM-17 headers and answer `If-None-Match` with `304` | R-MEM-17 | integration |
