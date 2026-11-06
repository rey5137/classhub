#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanUpOnSignals, verifyArchive, verifySnapshot } from './lib/verify-backup.mjs';

const usage = 'usage: npm run verify-backup -- <archive.tar.age | dir> [--identity <key.txt>]';

/**
 * R-BAK-04 CLI. An archive needs the age identity (`--identity` or AGE_IDENTITY_FILE).
 * @param {string[]} args @param {NodeJS.ProcessEnv} env
 * @param {{ out?: (line: string) => void; err?: (line: string) => void; decrypt?: NonNullable<Parameters<typeof verifyArchive>[2]>['decrypt'] }} [io]
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
  let result;
  if (statSync(target).isDirectory()) result = await verifySnapshot(resolve(target));
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
    result = await verifyArchive(resolve(target), resolve(identity), { decrypt: io.decrypt });
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) err(`verify-backup: FAIL ${error}`);
    return 1;
  }
  const manifest = /** @type {NonNullable<typeof result.manifest>} */ (result.manifest);
  out(
    `verify-backup: OK ${manifest.exportedAt}, app ${manifest.appVersion}, schema ${manifest.schemaVersion}, ${manifest.objects.count} objects (${manifest.objects.totalBytes} bytes).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Decrypted member data must not outlive a Ctrl-C (R-BAK-04: a private temporary dir).
  cleanUpOnSignals('verify-backup');
  process.exitCode = await runVerifyBackup(process.argv.slice(2), process.env);
}
