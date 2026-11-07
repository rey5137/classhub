#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { secretsFromEnvFile } from './lib/backup-scan.mjs';
import { cleanUpOnSignals, verifyArchive, verifySnapshot } from './lib/verify-backup.mjs';

const usage = 'usage: npm run verify-backup -- <archive.tar.age | dir> [--identity <key.txt>]';

/**
 * R-BAK-04 CLI. An archive needs the age identity (`--identity` or AGE_IDENTITY_FILE).
 * `secrets`: the `.env.cloudflare` values no file may contain (AC-BAK-08); a machine without
 * that file scans for the provider hosts only, and says so.
 * @param {string[]} args @param {NodeJS.ProcessEnv} env
 * @param {{ out?: (line: string) => void; err?: (line: string) => void; secrets?: import('./lib/backup-scan.mjs').Secret[]; decrypt?: NonNullable<Parameters<typeof verifyArchive>[2]>['decrypt'] }} [io]
 * @returns {Promise<number>}
 */
export async function runVerifyBackup(args, env, io = {}) {
  const out = io.out ?? ((/** @type {string} */ line) => console.log(line));
  const err = io.err ?? ((/** @type {string} */ line) => console.error(line));
  const [target, ...rest] = args;
  let identity = env.AGE_IDENTITY_FILE || undefined;
  if (rest.length === 2 && rest[0] === '--identity' && rest[1]) identity = rest[1];
  else if (rest.length !== 0) {
    err(usage);
    return 1;
  }
  if (!target || !existsSync(target)) {
    err(usage);
    return 1;
  }
  const secrets = io.secrets ?? [];
  let result;
  if (statSync(target).isDirectory()) result = await verifySnapshot(resolve(target), { secrets });
  else {
    if (!target.endsWith('.tar.age')) {
      err('verify-backup: give a classhub-backup-*.tar.age archive or an extracted directory.');
      return 1;
    }
    if (!identity || !existsSync(identity)) {
      err(
        'verify-backup: an archive needs the age identity: --identity <key.txt> or AGE_IDENTITY_FILE.',
      );
      return 1;
    }
    result = await verifyArchive(resolve(target), resolve(identity), {
      decrypt: io.decrypt,
      secrets,
    });
  }
  for (const warning of result.warnings) err(`verify-backup: WARN ${warning}`);
  if (result.errors.length > 0) {
    for (const error of result.errors) err(`verify-backup: FAIL ${error}`);
    return 1;
  }
  const manifest = /** @type {NonNullable<typeof result.manifest>} */ (result.manifest);
  out(
    secrets.length
      ? `verify-backup: no file holds an account id or token from any of ${secrets.length} .env.cloudflare values, and no file the backup wrote names a provider host.`
      : 'verify-backup: no file the backup wrote names a provider host; without .env.cloudflare here, the account id and tokens were not checked.',
  );
  out(
    `verify-backup: OK ${manifest.exportedAt}, app ${manifest.appVersion}, schema ${manifest.schemaVersion}, ${manifest.objects.count} objects (${manifest.objects.totalBytes} bytes).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Decrypted member data must not outlive a Ctrl-C (R-BAK-04: a private temporary dir).
  cleanUpOnSignals('verify-backup');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  process.exitCode = await runVerifyBackup(process.argv.slice(2), process.env, {
    secrets: secretsFromEnvFile(root),
  });
}
