# Contributing to Class Hub

Thanks for helping. Class Hub is spec-first: `docs/spec/` says what the site does, `docs/plan/plan.md` says in which
order it gets built. Read `docs/spec/SPEC.md` before your first change; it routes you to the one or two child files
your change touches.

## Ground rules

- **Privacy first.** Never commit real member data, photos, backups, Cloudflare account ids, API tokens or OAuth
  secrets (spec INV-6). Fixtures and screenshots use synthetic people only.
- **The invariants** (`INV-1`…`INV-9`, spec §1.2) and the locked decisions (`D1`–`D10`, §1.1) are not changed by a
  pull request alone; open an issue first.
- **Cite ids, don't restate the spec**, in code comments, commit messages and test titles (`R-AUTH-04`,
  `AC-MEM-07`). A test that proves an acceptance criterion starts its title with the id.
- **Server-side authorization only.** Hiding a button is never a permission check (R-NAV-05).
- **Provider code stays in adapters** (`src/lib/server/adapters/cloudflare/`, INV-4).
- **Every remote Cloudflare command goes through `scripts/cf.mjs`** (INV-9); never call `wrangler` against a remote
  resource directly.

## Workflow

- One phase at a time, in plan order. A phase lives on a branch `pN-<name>` from `main`; docs-only changes go on
  `docs/<topic>`, fixes on `fix/<topic>`. Nothing is committed straight to `main`.
- One green commit per slice, Conventional Commits with the area as scope and the slice and criteria it proves:
  `feat(auth): Access JWT verification and uniform denial (1a; AC-AUTH-01..05)`. Spec edits use `docs(spec)`, plan
  edits `docs(plan)`.
- A phase is verified when its Manual Verification Checklist passes and its last commit is merged to `main` with
  `--ff-only` and tagged `pN-verified`. Progress is read from git (`git branch`, `git tag -l 'p*-verified'`), never
  from a tracker file.

## Checks

`npm run verify` runs lint, type checks, unit, contract, integration and security tests, migration tests and both
builds. Pull requests must pass it; CI also runs the Playwright end-to-end suite. (The scripts arrive with plan slice
0a.)

## Reporting security issues

Please don't open a public issue for a vulnerability; see `SECURITY.md` (added before the first release) or contact
the maintainer privately through GitHub.
