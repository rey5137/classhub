import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1Remote } from './cf-child.mjs';

// The D1 schema version as migration names: the repo's files against the remote
// `d1_migrations` table the migrations command keeps (R-OPS-08, R-OPS-10).

/** @param {string} root @param {string} [dir] @returns {string[]} */
export function localMigrations(root, dir = 'migrations') {
  const path = join(root, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/** @param {import('./cf-child.mjs').CfRunner} run @returns {Promise<string[]>} */
export async function remoteMigrations(run) {
  const [rows = []] = await d1Remote(run, ['select name from d1_migrations order by id']);
  return rows.map((row) => String(row.name));
}

/**
 * @param {string[]} local @param {string[]} remote
 * @returns {{ pending: string[]; ahead: string[] }} `ahead`: applied remotely, unknown here
 */
export function compareMigrations(local, remote) {
  const applied = new Set(remote);
  const known = new Set(local);
  return {
    pending: local.filter((name) => !applied.has(name)),
    ahead: remote.filter((name) => !known.has(name)),
  };
}
