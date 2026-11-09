# Contributing to Class Hub

Thanks for helping. Class Hub is spec-first: `docs/spec/` says what the site does, `docs/plan/plan.md` says in which
order it gets built. Read `docs/spec/SPEC.md` before your first change; it routes you to the one or two child files
your change touches.

## Set up a checkout

```bash
npm ci
npm run dev:offline    # http://127.0.0.1:5173, a local SQLite database and no Cloudflare account
npm run db:seed:demo   # synthetic classmates, photos, threads and chat for local work
```

`npm run dev` uses the local Cloudflare platform emulation (D1, R2, Durable Objects); `dev:offline` is the fast loop
and needs no credentials. The local database and media live in `data/`, which is gitignored.

## Ground rules

- **Privacy first.** Never commit real member data, photos, backups, Cloudflare account ids, API tokens or OAuth
  secrets (spec INV-6). Fixtures and screenshots use synthetic people only (`@example.test` addresses).
- **The invariants** (`INV-1`…`INV-9`, spec §1.2) and the locked decisions (`D1`–`D10`, §1.1) are not changed by a
  pull request alone; open an issue first.
- **Cite ids, don't restate the spec**, in code comments, commit messages and test titles (`R-AUTH-04`,
  `AC-MEM-07`). A test that proves an acceptance criterion starts its title with the id.
- **Server-side authorization only.** Hiding a button is never a permission check (R-NAV-05).
- **Provider code stays in adapters** (`src/lib/server/adapters/cloudflare/`, INV-4).
- **Every remote Cloudflare command goes through `scripts/cf.mjs`** (INV-9); never call `wrangler` against a remote
  resource directly.
- **Every user-visible string** goes into both `src/lib/i18n/vi.ts` and `src/lib/i18n/en.ts` (R-UI-10), and components
  use theme tokens only (R-UI-05).

## Tests

- `npm run test` runs the unit and integration suites (Vitest).
- `npm run test:security` runs the security suites, including the route sweep and import-boundary checks.
- `npm run test:migrations` applies every migration on D1 (local) and `better-sqlite3`.
- `npm run test:e2e` runs the Playwright end-to-end suite; run `npx playwright install chromium` once.
- `npm run screenshots` writes every route × theme × mode × size to `.screenshots/` for visual review.
- `npm run ac:report` prints every acceptance criterion as covered, manual or missing.

Add a test for every behaviour you change. A test that proves an acceptance criterion starts its title with the id,
for example `it('AC-AUTH-05 …')`.

## Checks

`npm run verify` runs lint, type checks, unit, contract, integration and security tests, migration tests and both
builds. Pull requests must pass it; CI also runs the Playwright end-to-end suite. Run `npm run format` before you
commit if you changed formatting.

## Workflow

- One phase at a time, in plan order. A phase lives on a branch `pN-<name>` from `main`; docs-only changes go on
  `docs/<topic>`, fixes on `fix/<topic>`. Nothing is committed straight to `main`.
- One green commit per slice, Conventional Commits with the area as scope and the slice and criteria it proves:
  `feat(auth): Access JWT verification and uniform denial (1a; AC-AUTH-01..05)`. Spec edits use `docs(spec)`, plan
  edits `docs(plan)`.
- A phase is verified when its Manual Verification Checklist passes and its last commit is merged to `main` with
  `--ff-only` and tagged `pN-verified`. Progress is read from git (`git branch`, `git tag -l 'p*-verified'`), never
  from a tracker file.

## Reporting security issues

Please don't open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md): report it privately through
GitHub security advisories.

## Code of conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
