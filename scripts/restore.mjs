#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { secretsFrom } from './lib/backup-scan.mjs';
import { openChatDatabase } from './lib/chat-target.mjs';
import { root, runCf } from './lib/cf-child.mjs';
import { readEnvFile } from './lib/env-file.mjs';
import { guardedTargets } from './lib/guarded-targets.mjs';
import { runRestoreChat } from './lib/restore-chat.mjs';
import { runRestore } from './lib/restore.mjs';
import { createS3Client } from './lib/s3.mjs';
import { cleanUpOnSignals } from './lib/verify-backup.mjs';

const usage = `usage: npm run restore -- <archive.tar.age | dir> --target new --database <name> --bucket <name> [--identity <key.txt>]
       npm run restore -- <archive.tar.age | dir> --target local [--identity <key.txt>]
       npm run restore -- --chat <chat/…ndjson.age> [--identity <key.txt>]
  --identity (or AGE_IDENTITY_FILE) decrypts for this run only; keep it away from the archives.
  --target new writes a new, empty D1 database and bucket in this account, never the live ones;
  it needs R2_RESTORE_ACCESS_KEY_ID / R2_RESTORE_SECRET_ACCESS_KEY (Object Read & Write on that
  bucket) in .env.cloudflare. --target local writes CLASSHUB_DB (data/dev.sqlite) and
  CLASSHUB_OBJECTS (data/objects) for npm run dev:offline.`;

const restoreEnvSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/),
  R2_RESTORE_ACCESS_KEY_ID: z.string().min(1),
  R2_RESTORE_SECRET_ACCESS_KEY: z.string().min(1),
});
const VALUE_FLAGS = ['--target', '--database', '--bucket', '--identity', '--chat'];

/**
 * @param {string[]} args
 * @returns {{ source?: string; values: Record<string, string> } | null}
 */
export function parseRestoreArgs(args) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string | undefined} */
  let source;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      if (source !== undefined || !arg) return null;
      source = arg;
      continue;
    }
    const value = args[index + 1];
    if (!VALUE_FLAGS.includes(arg) || arg in values || !value || value.startsWith('--'))
      return null;
    values[arg] = value;
    index += 1;
  }
  const chat = '--chat' in values;
  const target = values['--target'];
  if (chat) {
    if (source !== undefined || target || values['--database'] || values['--bucket']) return null;
  } else if (
    source === undefined ||
    !(
      (target === 'new' && values['--database'] && values['--bucket']) ||
      (target === 'local' && !values['--database'] && !values['--bucket'])
    )
  )
    return null;
  return { source, values };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A signal must not leave decrypted member data, partial files or the lock behind.
  cleanUpOnSignals('restore');
  const options = parseRestoreArgs(process.argv.slice(2));
  const identity = options?.values['--identity'] ?? (process.env.AGE_IDENTITY_FILE || undefined);
  if (!options) {
    console.error(usage);
    process.exitCode = 1;
  } else if (options.values['--chat']) {
    // R-CHAT-15: into the live D1 through the guard, never --local (the gate reads D1).
    const target = openChatDatabase('restore --chat', root, { local: false });
    if (target) {
      try {
        process.exitCode = await runRestoreChat({
          database: target.database,
          run: runCf,
          file: resolve(options.values['--chat']),
          identity: identity && resolve(identity),
        });
      } finally {
        target.close();
      }
    }
  } else {
    const file = readEnvFile(join(root, '.env.cloudflare'));
    const common = {
      source: resolve(/** @type {string} */ (options.source)),
      identity: identity && resolve(identity),
      root,
      // AC-BAK-08: the same scan as verify-backup; none without .env.cloudflare (--target local).
      secrets: secretsFrom(file),
    };
    if (options.values['--target'] === 'local') {
      process.exitCode = await runRestore({
        ...common,
        target: {
          kind: 'local',
          dbFile: resolve(process.env.CLASSHUB_DB || join(root, 'data', 'dev.sqlite')),
          objectsDir: resolve(process.env.CLASSHUB_OBJECTS || join(root, 'data', 'objects')),
        },
      });
    } else {
      let target;
      try {
        const env = restoreEnvSchema.parse(file);
        const bucket = options.values['--bucket'] ?? '';
        target = /** @type {const} */ ({
          kind: 'new',
          run: runCf,
          database: options.values['--database'] ?? '',
          bucket,
          live: guardedTargets(root, env.CLOUDFLARE_ACCOUNT_ID),
          storage: createS3Client({
            account: env.CLOUDFLARE_ACCOUNT_ID,
            bucket,
            accessKey: env.R2_RESTORE_ACCESS_KEY_ID,
            secretKey: env.R2_RESTORE_SECRET_ACCESS_KEY,
          }),
        });
      } catch {
        // Zod errors can echo .env.cloudflare values; say what to check instead.
        console.error(
          'restore: --target new needs wrangler.jsonc (npm run setup), a valid --bucket name, and CLOUDFLARE_ACCOUNT_ID, R2_RESTORE_ACCESS_KEY_ID and R2_RESTORE_SECRET_ACCESS_KEY in .env.cloudflare.',
        );
        process.exitCode = 1;
      }
      if (target) process.exitCode = await runRestore({ ...common, target });
    }
  }
}
