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
| A self-hosted Access application on `workers.dev` may still not pass a WebSocket upgrade (unverified; Cloudflare documents 403 only for Worker-level Access) | slice 1d proves a `101` through real Access with an echo stub before identity builds on it; fallback is a custom domain with one Access application and one AUD (R-OPS-16) |
| A deploy lands in the wrong Cloudflare account | account guard, `account_id` in `wrangler.jsonc`, deploy refuses mismatches (INV-9) |
| Incomplete backup during an outage | manifest, checksums, live-count check, `completed` flag; a partial snapshot is never a backup (§13) |
| A photo is deleted while a backup copies objects | deleted photos keep their objects for a grace period (7 days default) and backups run at least weekly (R-BAK-16) |
| A restore overwrites or mixes with the live site | restore refuses a non-empty database or bucket and any id equal to the live binding, and restores locked (R-BAK-06) |
| Photos resized, originals lost | the upload screen says Class Hub stores optimized copies (R-MEM-05) |
| A member over-shares contact data | private by default, per-field consent, one projection function (§4) |
| Cloudflare lock-in | ports, SQL schema, no chat in the DO, local adapters pass the same contract suites (R-PLAT-06); a production Node target is deferred (§D) |
| Push CPU and fan-out on Workers Free (10 ms CPU and 50 subrequests per invocation; a 30-device event cannot be encrypted and sent in one) | encryption runs inside `PushDelivery`, one batch of ≤ 40 per invocation, the VAPID JWT signed once per push service per event, items and summaries in one ≤ 7-batch `send`, no `PUSH` binding means no push (R-NTF-05); confirm "CPU time p99" on the live site at checklist item 8 |
| Theme changes break upgrades | tokens only, no forked pages, screenshot and axe checks (§10) |
| The only admin leaves | second-admin prompt, documented credential and backup handover (R-AUTH-14) |
| Backups keep deleted personal data | mandatory `age` encryption, documented retention, deletions age out (R-BAK-11) |
| SvelteKit's Cloudflare output can't export a Durable Object class | a wrapping Worker entry, proved in slice 0a before anything depends on it (R-PLAT-02) |
| Access JWT missing on a WebSocket upgrade in some browsers | cookie fallback for the upgrade only, verified the same way (R-AUTH-03), tested on iOS Safari in 4b |
