// `npm run deploy`, between the account guard and the build: refuse when the
// PUSH service binding is missing (R-OPS-10) or the remote schema is ahead of this checkout (R-OPS-08), since older code against a
// newer schema could misread or overwrite data; then write the Access vars from
// .env.cloudflare into wrangler.jsonc (R-AUTH-05, R-OPS-06 step 7).

import { join } from 'node:path';
import { compareMigrations, localMigrations, remoteMigrations } from './migrations.mjs';
import {
  hasPushBinding,
  PUSH_BINDING_MISSING,
  readWorkerConfig,
  serializeConfig,
  withAccessVars,
} from './worker-config.mjs';

/**
 * @param {{
 *   run: import('./cf-child.mjs').CfRunner;
 *   root: string;
 *   env: Record<string, string>;
 *   write: (path: string, text: string) => void;
 *   out: (line: string) => void;
 * }} deps
 * @returns {Promise<number>}
 */
export async function checkDeploy(deps) {
  const config = readWorkerConfig(deps.root);
  if (!config) throw new Error('wrangler.jsonc does not exist; run npm run setup.');

  // R-NTF-05, R-OPS-10: without the PUSH self-binding a production Worker cannot deliver push.
  if (!hasPushBinding(config)) {
    deps.out(`Deploy refused: missing ${PUSH_BINDING_MISSING}. Run npm run setup.`);
    return 1;
  }

  let remote;
  try {
    remote = await remoteMigrations(deps.run);
  } catch (error) {
    // Fail closed: an unknown schema version is not a safe one to deploy over.
    deps.out(
      `Deploy refused: cannot read the remote schema version (${/** @type {Error} */ (error).message}). Run npm run setup first.`,
    );
    return 1;
  }
  const db = (config.d1_databases ?? []).find(
    (/** @type {any} */ entry) => entry?.binding === 'DB',
  );
  const { ahead } = compareMigrations(localMigrations(deps.root, db?.migrations_dir), remote);
  if (ahead.length > 0) {
    deps.out(
      `Deploy refused: the database has migrations this checkout lacks (${ahead.join(', ')}). git pull --ff-only to the release that added them.`,
    );
    return 1;
  }

  // Rewritten only when a var changes, so a hand-edited file keeps its comments.
  const synced = withAccessVars(config, deps.env);
  if (JSON.stringify(synced.vars) !== JSON.stringify(config.vars)) {
    deps.write(join(deps.root, 'wrangler.jsonc'), serializeConfig(synced));
    deps.out('wrangler.jsonc: Access vars updated from .env.cloudflare.');
  }
  return 0;
}
