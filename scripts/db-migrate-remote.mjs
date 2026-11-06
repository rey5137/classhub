#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { backupGate, DESTRUCTIVE_MIGRATION } from './lib/backup-gate.mjs';
import { reason, root, runCf } from './lib/cf-child.mjs';
import { compareMigrations, localMigrations, remoteMigrations } from './lib/migrations.mjs';

/**
 * R-OPS-12 / AC-OPS-06: applies the remote migrations only after the INV-7 gate passes; the
 * only script that applies a `*_destructive.sql` migration to a database already in use.
 * @param {{ run: import('./lib/cf-child.mjs').CfRunner; root: string; out?: (line: string) => void; err?: (line: string) => void }} deps
 * @returns {Promise<number>}
 */
export async function runMigrateRemote(deps) {
  const out = deps.out ?? ((/** @type {string} */ line) => console.log(line));
  const err = deps.err ?? ((/** @type {string} */ line) => console.error(line));
  const gate = await backupGate(deps.run);
  if (!gate.ok) {
    err(`db:migrate:remote: refused: ${gate.detail}`);
    err(`  fix: ${gate.fix}`);
    return 1;
  }
  out(`db:migrate:remote: ${gate.detail}`);
  let pending;
  try {
    pending = compareMigrations(
      localMigrations(deps.root),
      await remoteMigrations(deps.run),
    ).pending;
  } catch (error) {
    err(
      `db:migrate:remote: cannot read the applied migrations: ${/** @type {Error} */ (error).message}`,
    );
    return 1;
  }
  if (pending.length === 0) {
    out('db:migrate:remote: no pending migrations.');
    return 0;
  }
  // Never silently (R-OPS-12): name each destructive step before it runs.
  for (const name of pending)
    out(`db:migrate:remote: ${DESTRUCTIVE_MIGRATION.test(name) ? 'DESTRUCTIVE ' : ''}${name}`);
  const applied = deps.run(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (applied.status !== 0) {
    err(`db:migrate:remote: failed: ${reason(applied)}`);
    return 1;
  }
  out(`db:migrate:remote: applied ${pending.length} migration(s).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) {
    console.error('usage: npm run db:migrate:remote');
    process.exitCode = 1;
  } else process.exitCode = await runMigrateRemote({ run: runCf, root });
}
