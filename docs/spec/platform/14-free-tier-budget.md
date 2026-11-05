# 14 — Free-tier budget and graceful failure

**Covers:** Cloudflare free allowances, the app's guardrails, behaviour when a limit is hit, cost honesty.
**Read when:** adding a request, a query on a hot path, a scheduled job, storage use or anything that counts against a Cloudflare limit.
**Owns:** `R-BUD-*`, `AC-BUD-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§14.n` is in this file.

---

## 14.1 Allowances and guardrails

Re-checked against Cloudflare's docs on 2026-11-05 (slice 1d, AC-BUD-01): Workers, D1, R2 and Durable Objects
figures match the limits and pricing pages. The Zero Trust 50-user figure is not stated on a public page; the owner
confirms it on the Zero Trust plan screen in the dashboard (1d owner step).

| Product | Free allowance | Guardrail |
|---|---|---|
| Workers Free | 100,000 requests/day; 10 ms CPU per request | server-rendered pages with small payloads; no server-side image work; static assets cached immutable |
| D1 Free | 5 M rows read/day; 100 K rows written/day | indexed, bounded queries; maintained counters; no polling |
| D1 Free | 500 MB per database; 5 GB per account | `/admin` warns at 250 MB (target < 100 MB) |
| R2 Standard | 10 GB-month; 1 M Class A, 10 M Class B ops/month | 8 GB warn, 9 GB stop (R-MEM-15); app-counted operation estimate |
| Durable Objects Free | SQLite-backed classes only; 100,000 requests/day; 13,000 GB-s duration/day; 1 GB storage per object | hibernation; no timers or loops (R-CHAT-07) |
| Zero Trust Free | 50 users (confirm in the dashboard) | seat count on the invite screen (R-AUTH-19) |

- **R-BUD-01** **Expected use** for 50 members is far inside every allowance (order of a few thousand requests and
  under 100 K rows read per day); the guardrails exist for misuse and runaway clients.
- **R-BUD-02** **No background work for ordinary viewing:** no cron every minute, no presence polling, no per-user
  jobs. Housekeeping runs piggy-backed at most hourly on traffic (releasing and purging at most 20 rows per run) or from the CLI (R-MEM-11); `users.last_seen_at` is written at most once an hour per member (R-AUTH-26); the weekly reconcile is CLI-only. A Cron Trigger, if
  added, runs no more than daily.
- **R-BUD-03** Client-side lightness: chat and gallery routes are lazy-loaded; thumbnails are made in the browser;
  no external analytics, fonts or search.
- **R-BUD-08** **Large deletes run in chunks.** Anything that deletes or rewrites many rows (purging a thread, pruning chat
  after archive (`prune-chat`, R-CHAT-18), purging deleted photos, rewriting `effective_year` for a big album) works in batches of at most 500
  rows and stays under 20,000 rows written per run, resuming on the next run or CLI call, so no single job approaches
  the D1 Free 100 K rows written/day limit.
- **R-BUD-09** Backups are local encrypted files on the admin's computer or drive, never stored in R2 (R-BAK-10, §13.3); the backup reads R2 objects (Class B operations) but writes nothing to the bucket.
- **R-BUD-04** The D1 database size is read through the D1 API by `preflight` and the CLI (the Worker holds no API
  token) and stored in `backup_runs`/`site_settings` for `/admin`.

## 14.2 When a limit is hit

- **R-BUD-05** R2 near the cap: uploads stop, browsing continues. D1 write errors: content writes fail with
  `unavailable` and a clear message; reads continue. Worker or DO limits: the client shows a temporary error and
  retry guidance; chat never shows unsaved messages as sent (INV-8).
- **R-BUD-06** Authorization fails closed under every failure (INV-1); no Worker route uses fail-open behaviour.
- **R-BUD-07** **Honesty about cost:** the README's first screen and `docs/DEPLOY_CLOUDFLARE.md` state that R2 needs
  billing activation, that the app's cap is not a billing cap (another app in the same account, operations, or
  provider overage can bill), recommend a dedicated account and billing notifications, and list the possible costs:
  custom domain, off-site backup storage, overage.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-BUD-01 | Each §14.1 figure is confirmed on Cloudflare's current pages and corrected if it differs | — | manual 1d |
| AC-BUD-02 | A page view of each route stays within its row-read budget with the demo seed: 30 rows for single-record routes, and 2 × page size + 10 for list routes such as `/members` (a 50-row page, so ≤ 110); the per-route budgets live beside the test | R-BUD-01 | integration (row counter on the adapter) |
| AC-BUD-03 | Opening any page performs no repeating request while idle for 5 minutes | R-BUD-02 | e2e network log |
| AC-BUD-04 | With D1 writes failing, reads still render and writes show `unavailable` | R-BUD-05 | integration |
| AC-BUD-05 | The README and deploy guide carry the R-BUD-07 statements | R-BUD-07 | review 6a |
