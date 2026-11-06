# D — Deferred features

**Covers:** Ideas kept for after v1.0, with why they wait. Owns no rules.
**Read when:** someone proposes one of these; build none of them without an owner decision moving it into the spec.
**Owns:** nothing.
**Index:** `docs/spec/SPEC.md`.

---

| Feature | Why it waits |
|---|---|
| Presigned S3 uploads straight to R2 | Worker-proxied uploads are simpler to secure at this size; revisit if throughput grows (needs strict finalize and post-upload size checks, never long-lived credentials) |
| Comments on photos | the board covers discussion; adds a moderation surface |
| Chat attachments, reactions, threads | outside the small text-chat goal and the R2 budget |
| Full-text search | needs FTS or a hosted service; directory and title search cover v1.0 |
| Email notifications | needs a mail sender service; push (§16) covers alerts |
| Several rooms or several classes per deployment | one class per deployment is a core boundary (§1) |
| Video and originals | storage budget (§14) |
| In-app Access policy edits from the Worker | would put a Cloudflare API token in the Worker; the CLI does it (R-AUTH-18) |
| Automatic scheduled backups to a cloud drive | the canonical backup is the admin's local CLI run (D10) |
| Public read-only "reunion info" page | everything is private in v1.0 (§1) |
| Production Node server (`adapter-node` deployment, `ws` hub, OIDC identity adapter, `docs/SELF_HOST_NODE.md`, `build:node` in CI) | the local adapters already prove portability through `dev:offline` and `restore --target local`; an identity adapter and a second runtime to maintain are not needed by the reference deployment (R-BAK-13, AC-BAK-07; re-linking by email after a restore stays in v1.0, R-BAK-14) |
| Importers for older schema versions (N-1, N-2) | v1.0 restores a backup only into the same schema version (R-BAK-06); the first schema change brings the need |
| OpenAPI generation (`docs/openapi.json`, `npm run openapi`) | the Zod DTOs are the contract and the API has one client (R-API-04, AC-API-04) |
