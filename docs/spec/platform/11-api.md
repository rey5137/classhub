# 11 — API contract (v1)

**Covers:** The `/api/v1` routes, the error shape, pagination, the port interfaces.
**Read when:** adding or changing an endpoint, a DTO or a port.
**Owns:** `R-API-*`, `AC-API-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§11.n` is in this file.

---

## 11.1 Conventions

- **R-API-01** Every endpoint except `GET /health`, `GET /manifest.webmanifest` and the icons under `/icons/` (R-NAV-07), `GET`/`POST /join` (R-AUTH-27) and the public build assets under `/_app/` requires a verified identity and an active membership (INV-1);
  admin endpoints also require `role = admin`.
- **R-API-02** Errors are `{ error: { code, message, requestId } }` with a stable `code`: `unauthenticated`,
  `forbidden`, `locked`, `not_found`, `validation` (plus `fields`), `rate_limited` (an upload refusal adds `reason`: `daily` or `concurrent`, R-MEM-13), `storage_full`,
  `feature_disabled`, `conflict`, `payload_too_large`, `unavailable`, `internal`. A JSON API sent another
  `Content-Type` (R-AUTH-17) answers `415` with code `validation`. `message` is a localized,
  non-sensitive sentence; `requestId` is echoed in the `X-Request-Id` header.
- **R-API-03** Lists return `{ items, nextCursor }`; the cursor is an opaque base64url of the keyset values.
- **R-API-04** Request and response DTOs are Zod schemas in `src/lib/contracts/`. Generating `docs/openapi.json` from
  them is deferred past v1.0 (§D).
- **R-API-05** `GET /health` returns `{ ok: true, version }` and nothing that identifies a member, setting or count.

## 11.2 Routes

| Method | Route | Behaviour |
|---|---|---|
| `GET` | `/api/v1/me` | current member, own full profile, role |
| `PATCH` | `/api/v1/me` | update own names, contacts, visibility, avatar id (the locale stays client-side, R-UI-10) |
| `GET` | `/api/v1/me/export` | own data export (R-PROF-09) |
| `POST` | `/api/v1/me/deletion-request` | request deletion (R-PROF-11) |
| `GET` | `/api/v1/members` | directory, visibility-projected, `?q=&cursor=` |
| `GET` | `/api/v1/members/:id` | one projected profile |
| `GET` | `/api/v1/info` · `/api/v1/info/:slug` | info pages |
| `GET` · `POST` | `/api/v1/posts` | list (`?cursor=`) · create |
| `GET` · `PATCH` · `DELETE` | `/api/v1/posts/:id` | read · update (owner/admin; pin and lock admin) · delete |
| `GET` · `POST` | `/api/v1/posts/:id/comments` | list · add |
| `PATCH` · `DELETE` | `/api/v1/comments/:id` | update · delete (owner/admin) |
| `GET` · `POST` | `/api/v1/albums` | list · create |
| `PATCH` | `/api/v1/albums/:id` | update (creator/admin) |
| `GET` | `/api/v1/media` | gallery, `?album=&year=&cursor=` |
| `POST` | `/api/v1/media/reservations` | quota-checked reservation (R-MEM-06) |
| `PUT` | `/api/v1/media/reservations/:id/:variant` | streamed upload (R-MEM-07) |
| `POST` | `/api/v1/media/reservations/:id/complete` | finalize (R-MEM-09) |
| `DELETE` | `/api/v1/media/reservations/:id` | abandon (R-MEM-10) |
| `GET` | `/api/v1/media/:id/:variant` | authorized image stream (R-MEM-16) |
| `PATCH` · `DELETE` | `/api/v1/media/:id` | caption/album · delete (owner/admin) |
| `GET` | `/api/v1/chat/messages` | `?before=` or `?after=`, 50 per page |
| `DELETE` | `/api/v1/chat/messages/:id` | tombstone (sender/admin) |
| `GET` (upgrade) | `/api/v1/chat/ws` | WebSocket (R-CHAT-04) |
| `GET` · `PATCH` | `/api/v1/notifications` | own kinds, mute, devices (labels only), VAPID public key · set kinds or mute (R-NTF-07, 09) |
| `POST` · `DELETE` | `/api/v1/notifications/subscriptions[/:id]` | store this device's subscription · remove one of own devices (R-NTF-08, 10) |
| `GET` · `PATCH` | `/api/v1/admin/settings` | site settings (§10.1) |
| `GET` · `POST` · `DELETE` | `/api/v1/admin/invites` | list with Access sync status · invite · revoke |
| `POST` | `/api/v1/admin/invites/:id/email` | send the invite email (R-AUTH-31) |
| `GET` · `POST` · `DELETE` | `/api/v1/admin/join-requests[/:id]` | pending requests · approve · reject (R-AUTH-30) |
| `PATCH` | `/api/v1/admin/members/:id` | role, suspend, reactivate, complete deletion (`{deletion: 'complete'}`), delete on a suspended person's behalf (`{deletion: 'on_behalf', keepContent}`, R-PROF-11a) |
| `POST` | `/api/v1/admin/info` | create an info page (R-BRD-02) |
| `PATCH` · `DELETE` | `/api/v1/admin/info/:id` | edit, pin, order · delete an info page |
| `GET` | `/api/v1/admin/usage` | quota, operations estimate, seats, backup and archive status |
| `POST` | `/api/v1/admin/exports/metadata` | bounded text/metadata export (posts, comments, media metadata; no contacts, no chat) |
| `GET` | `/health` | R-API-05 |

- **R-API-06** Full archives are CLI-only (D10); no endpoint promises to zip the whole site.

## 11.3 Ports

```ts
export interface ObjectStorage {
  put(key: string, body: ReadableStream<Uint8Array>, opts: { contentType: string; maxBytes: number }):
    Promise<{ size: number; sha256: string }>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  get(key: string, opts?: { ifNoneMatch?: string }):
    Promise<{ body: ReadableStream<Uint8Array> | null; size: number; contentType: string } | null>;
  delete(keys: string[]): Promise<void>;
  list(prefix: string, cursor?: string): Promise<{ objects: { key: string; size: number }[]; cursor?: string }>;
}

export interface IdentityProvider {
  /** Throws IdentityError when no verified identity is present (INV-1). */
  requireIdentity(request: Request): Promise<{ email: string; subject: string }>;
}

export interface RealtimeHub {
  connect(request: Request, member: { id: string; role: 'member' | 'admin'; displayName: string }): Promise<Response>;
  disconnectMember(memberId: string): Promise<void>;
  notify(event: { type: 'message.deleted'; id: string }): Promise<void>;
}

export interface PushTransport {
  // R-NTF-05: payloads already encrypted and VAPID-signed; returns one status per delivery for R-NTF-06
  send(deliveries: { subscriptionId: string; endpoint: string; headers: Record<string, string>; body: Uint8Array }[]):
    Promise<{ subscriptionId: string; status: number | 'network_error' }[]>;
}
```

- **R-API-07** `ObjectStorage.put` enforces `maxBytes` while streaming and returns the measured size and hash; the R2
  adapter and the filesystem adapter pass the same contract suite (R-PLAT-06).

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-API-01 | Every route in §11.2 returns the uniform denial without identity, and the error shape on every failure | R-API-01, 02 | `test:security` route sweep (from the route manifest) |
| AC-API-02 | Admin routes refuse members | R-API-01 | integration |
| AC-API-03 | `/health` contains no member, setting or count | R-API-05 | integration |
| AC-API-04 | *Deferred (§D):* OpenAPI generation and its CI diff | R-API-04 | n/a |
| AC-API-05 | `put` stops at `maxBytes` on both storage adapters | R-API-07 | contract `ObjectStorage` |
