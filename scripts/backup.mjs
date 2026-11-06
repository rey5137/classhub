#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appVersionOf, backupDependencies, runBackup } from './lib/backup.mjs';
import { runCf } from './lib/cf-child.mjs';
import { cleanUpOnSignals } from './lib/verify-backup.mjs';

const usage = 'usage: npm run backup -- [--out <dir>] [--recipient age1…]';

/** @param {string[]} args @returns {{ out?: string; recipient?: string } | null} */
export function parseBackupArgs(args) {
  /** @type {{ out?: string; recipient?: string }} */
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return null;
    if (flag === '--out' && options.out === undefined) options.out = value;
    else if (flag === '--recipient' && options.recipient === undefined) options.recipient = value;
    else return null;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  // A signal must not leave plaintext staging or the lock behind (R-BAK-05, R-BAK-03).
  cleanUpOnSignals('backup');
  const options = parseBackupArgs(process.argv.slice(2));
  if (!options) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    let deps;
    try {
      deps = backupDependencies(root);
    } catch {
      // Zod and parse errors can echo .env.cloudflare values; say what to check instead.
      console.error(
        'backup: needs wrangler.jsonc (npm run setup) and, in .env.cloudflare, CLOUDFLARE_ACCOUNT_ID matching it plus R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.',
      );
      process.exitCode = 1;
    }
    if (deps) {
      process.exitCode = await runBackup({
        ...deps,
        run: runCf,
        appVersion: appVersionOf(root),
        recipient: options.recipient ?? deps.recipient,
        outDir: resolve(options.out ?? join(root, 'backups')),
      });
    }
  }
}
