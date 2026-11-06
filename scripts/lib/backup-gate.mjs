// INV-7 (R-OPS-12, R-DB-11): a destructive change waits for a verified backup newer than the
// last deploy. One gate for `db:migrate:remote`, `preflight` and `setup`; both reads go
// through the account guard (cf.mjs).

import { d1Remote, reason } from './cf-child.mjs';

/** R-DB-11: a destructive step is its own migration with this suffix. */
export const DESTRUCTIVE_MIGRATION = /_destructive\.sql$/;

/**
 * @param {import('./cf-child.mjs').CfRunner} run
 * @returns {Promise<{ ok: true; detail: string } | { ok: false; detail: string; fix: string }>}
 */
export async function backupGate(run) {
  const backupFix = 'run npm run backup (it must pass), then try again.';
  // The Worker's newest deployment; unreadable fails closed.
  const listed = run(['deployments', 'list', '--json']);
  // A Worker never deployed does not exist yet: the CLI fails with API code 10007
  // ("This Worker does not exist on your account"). Nothing has served members, so that
  // alone counts as no deployment; every other failure stays unreadable.
  const neverDeployed =
    listed.status !== 0 && /\[code: 10007\]/.test(`${listed.stderr}\n${listed.stdout}`);
  /** @type {number | null} */
  let deployedAt = null;
  if (!neverDeployed) {
    try {
      if (listed.status !== 0) throw new Error(reason(listed));
      // Plain checks, no Zod: setup and preflight import this and run without node_modules in tests.
      const parsed = JSON.parse(listed.stdout);
      if (!Array.isArray(parsed)) throw new Error('not a list of deployments');
      const times = parsed.map((entry) =>
        typeof entry?.created_on === 'string' ? Date.parse(entry.created_on) : NaN,
      );
      if (times.some((time) => !Number.isFinite(time))) throw new Error('unparseable created_on');
      // An empty list also means no deployment yet.
      if (times.length) deployedAt = Math.max(...times);
    } catch (error) {
      return {
        ok: false,
        detail: `cannot read the last deploy time (${/** @type {Error} */ (error).message}).`,
        fix: 'check that node scripts/cf.mjs deployments list --json works, then try again.',
      };
    }
  }
  /** @type {unknown} */
  let verifiedAt;
  try {
    const [rows = []] = await d1Remote(run, [
      'select max(verified_at) as at from backup_runs where verified_at is not null',
    ]);
    verifiedAt = rows[0]?.at ?? null;
  } catch (error) {
    return {
      ok: false,
      detail: `cannot read backup_runs (${/** @type {Error} */ (error).message}).`,
      fix: 'check the D1 binding with npm run preflight, then try again.',
    };
  }
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt))
    return { ok: false, detail: 'no verified backup exists.', fix: backupFix };
  const backup = new Date(verifiedAt).toISOString();
  if (deployedAt !== null && verifiedAt <= deployedAt)
    return {
      ok: false,
      detail: `the newest verified backup (${backup}) is not newer than the last deploy (${new Date(deployedAt).toISOString()}).`,
      fix: backupFix,
    };
  return {
    ok: true,
    detail: `verified backup ${backup} is newer than the last deploy${deployedAt === null ? ' (none yet)' : ` (${new Date(deployedAt).toISOString()})`}.`,
  };
}
