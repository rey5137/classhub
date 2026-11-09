import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one way a script reaches Cloudflare: a child running the account guard
// (scripts/cf.mjs, INV-9). The token never rides in argv or this child's env:
// cf.mjs reads .env.cloudflare itself. A secret goes in on stdin only.

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * @typedef {{ status: number; stdout: string; stderr: string }} CfResult
 * @typedef {(args: string[], options?: { input?: string }) => CfResult} CfRunner
 */

/** @type {CfRunner} */
export function runCf(args, options = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('CLOUDFLARE_')),
  );
  env.NO_COLOR = '1';
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'cf.mjs'), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    input: options.input ?? '',
    timeout: 5 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`cannot run cf.mjs: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The last line of a failed run, which is cf.mjs's or the CLI's own reason. */
export function reason(/** @type {CfResult} */ result) {
  const lines = `${result.stderr}\n${result.stdout}`.trim().split('\n');
  return lines.at(-1)?.trim() || `exit ${result.status}`;
}

/**
 * Runs the statements against the remote `DB` in order and returns each one's rows; `database`
 * names a restore target instead (R-BAK-06; cf.mjs takes only its pinned reads there).
 * @param {CfRunner} run @param {string[]} statements @param {string} [database]
 * @returns {Promise<Record<string, unknown>[][]>}
 */
export async function d1Remote(run, statements, database = 'DB') {
  const result = run([
    'd1',
    'execute',
    database,
    '--remote',
    '--json',
    '--command',
    statements.join(';\n'),
  ]);
  if (result.status !== 0) throw new Error(`d1 execute failed (${reason(result)})`);
  const parsed = JSON.parse(result.stdout);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  // Fail closed: a statement without a result set is an error, never "no rows".
  if (
    entries.length !== statements.length ||
    entries.some((entry) => !Array.isArray(entry?.results))
  ) {
    throw new Error('d1 execute returned an unexpected result shape');
  }
  return entries.map((entry) => /** @type {Record<string, unknown>[]} */ (entry.results));
}

/**
 * `cf.mjs api <path>` that tells "not there" (HTTP 404) from any other failure, so a
 * caller can create what is missing and fail closed on everything else.
 * @param {CfRunner} run @param {string} path
 * @returns {{ found: true; result: unknown } | { found: false; missing: boolean; reason: string }}
 */
export function apiLookup(run, path) {
  const result = run(['api', path]);
  if (result.status !== 0) {
    return { found: false, missing: /\bHTTP 404\b/.test(result.stderr), reason: reason(result) };
  }
  try {
    return { found: true, result: JSON.parse(result.stdout) };
  } catch {
    return { found: false, missing: false, reason: 'the API answer was not JSON' };
  }
}

/**
 * `cf.mjs api <path>`: the parsed `result`, or null when the GET failed.
 * @param {CfRunner} run @param {string} path @returns {unknown}
 */
export function apiGet(run, path) {
  const lookup = apiLookup(run, path);
  return lookup.found ? lookup.result : null;
}

/**
 * AC-MEM-08, INV-3: why a bucket is not reachable only through the Worker; empty when it is.
 * Fails closed: an answer without the expected fields counts as unreadable.
 * @param {CfRunner} run @param {string} bucket @returns {string[]}
 */
export function bucketExposures(run, bucket) {
  const managed = /** @type {{ enabled?: boolean } | null} */ (
    bucket ? apiGet(run, `/r2/buckets/${bucket}/domains/managed`) : null
  );
  const custom = /** @type {{ domains?: unknown[] } | null} */ (
    bucket ? apiGet(run, `/r2/buckets/${bucket}/domains/custom`) : null
  );
  return /** @type {string[]} */ (
    [
      typeof managed?.enabled !== 'boolean' && 'r2.dev status unreadable',
      managed?.enabled === true && 'public r2.dev URL enabled',
      !Array.isArray(custom?.domains) && 'custom domains unreadable',
      Array.isArray(custom?.domains) && custom.domains.length > 0 && 'a custom domain is connected',
    ].filter(Boolean)
  );
}
