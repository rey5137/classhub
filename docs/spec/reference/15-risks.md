# 15 — Risks and trade-offs

**Covers:** Named product and operational risks and the decision taken for each.
**Read when:** weighing a design change against a known risk. Owns no rules.
**Owns:** nothing.
**Index:** `docs/spec/SPEC.md`.

---

| Risk | Mitigation / decision |
|---|---|
| R2 free allowance exceeded or billed | 8/9 GB guardrails, operation estimate, billing notifications, dedicated account; no promise of a zero bill (§14) |
| 50 Zero Trust seats is tight | one identity per member, admins counted, seat warning at 45; beyond 50, replace the identity adapter or change plan |
| Access + Google setup isn't one click | setup prints exact values, `GOOGLE_ACCESS.md`, preflight, email PIN fallback (§12.4) |
| Worker-level Access breaks the WebSocket | hostname-based self-hosted Access only (D6) |
| A deploy lands in the wrong Cloudflare account | account guard, `account_id` in `wrangler.jsonc`, deploy refuses mismatches (INV-9) |
| Incomplete backup during an outage | manifest, checksums, `completed` flag; a partial snapshot is never a backup (§13) |
| Photos resized, originals lost | the upload screen says Class Hub stores optimized copies (R-MEM-05) |
| A member over-shares contact data | private by default, per-field consent, one projection function (§4) |
| Cloudflare lock-in | ports, SQL schema, no chat in the DO, Node target built in CI (§13.5) |
| Theme changes break upgrades | tokens only, no forked pages, screenshot and axe checks (§10) |
| The only admin leaves | second-admin prompt, documented credential and backup handover (R-AUTH-14) |
| Backups keep deleted personal data | encrypted archives, documented retention, deletions age out (R-BAK-11) |
| SvelteKit's Cloudflare output can't export a Durable Object class | a wrapping Worker entry, proved in slice 0a before anything depends on it (R-PLAT-02) |
| Access JWT missing on a WebSocket upgrade in some browsers | cookie fallback for the upgrade only, verified the same way (R-AUTH-03), tested on iOS Safari in 4b |
