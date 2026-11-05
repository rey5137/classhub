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
| Push or email notifications | needs a sender service and consent handling |
| Several rooms or several classes per deployment | one class per deployment is a core boundary (§1) |
| Video and originals | storage budget (§14) |
| In-app Access policy edits from the Worker | would put a Cloudflare API token in the Worker; the CLI does it (R-AUTH-18) |
| Automatic scheduled backups to a cloud drive | the canonical backup is the admin's local CLI run (D10) |
| Public read-only "reunion info" page | everything is private in v1.0 (§1) |
