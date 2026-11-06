import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createRemoteDatabase } from '../../src/lib/server/adapters/cloudflare/remote-database.ts';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database.ts';
import { runCf } from './cf-child.mjs';
import { readEnvFile } from './env-file.mjs';
import { guardedTargets } from './guarded-targets.mjs';

const accountSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** A refusal whose message is safe to print (a path, never a configuration value). */
export class ChatTargetError extends Error {}

/**
 * The one database seam of `export-chat` and `prune-chat`: `--local` opens the SQLite file
 * `dev:offline` uses (CLASSHUB_DB, else data/dev.sqlite); otherwise D1 through the account
 * guard (`cf.mjs d1-query`, INV-9), one statement per child. Throws on missing configuration.
 * @param {string} root @param {{ local: boolean; run?: typeof runCf; env?: NodeJS.ProcessEnv }} options
 * @returns {{ database: import('../../src/lib/server/ports/database.ts').Database; close: () => void; target: string }}
 */
export function chatDatabase(root, options) {
  if (options.local) {
    const configured = (options.env ?? process.env).CLASSHUB_DB;
    if (configured === '')
      throw new ChatTargetError(
        'CLASSHUB_DB is set but empty; unset it or name the dev:offline database file.',
      );
    const file = resolve(configured ?? join(root, 'data', 'dev.sqlite'));
    // A mistyped path must not become a fresh empty database that reports "nothing to do".
    if (!existsSync(file) || !statSync(file).isFile())
      throw new ChatTargetError(
        `${file} does not exist; --local never creates a database. Check CLASSHUB_DB, or run npm run db:seed:demo first.`,
      );
    const database = createLocalDatabase(file, { migrationsDir: join(root, 'migrations') });
    return { database, close: () => database.close(), target: file };
  }
  const env = readEnvFile(join(root, '.env.cloudflare'));
  const { databaseId } = guardedTargets(root, accountSchema.parse(env?.CLOUDFLARE_ACCOUNT_ID));
  const run = options.run ?? runCf;
  const database = createRemoteDatabase(async (statement) => {
    // A fixed pause keeps a long export or prune well under the API rate limit.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const result = run(['d1-query', databaseId], { input: JSON.stringify(statement) });
    if (result.status !== 0) throw new Error('Guarded Cloudflare request failed');
    return JSON.parse(result.stdout);
  });
  return { database, close: () => {}, target: 'remote D1' };
}

/**
 * Flags shared by both commands; `allowed` names the value flags a command takes.
 * @param {string[]} args @param {string[]} allowed
 * @returns {{ local: boolean; values: Record<string, string> } | null}
 */
export function parseChatArgs(args, allowed) {
  let local = false;
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? '';
    if (flag === '--local' && !local) {
      local = true;
      continue;
    }
    const value = args[index + 1];
    if (!allowed.includes(flag) || flag in values || !value || value.startsWith('--')) return null;
    values[flag] = value;
    index += 1;
  }
  return { local, values };
}

/**
 * Opens the database for a command's entry script; on a refusal prints it under the command's
 * name, sets a failing exit code and returns undefined.
 * @param {string} command @param {string} root @param {{ local: boolean }} options
 */
export function openChatDatabase(command, root, options) {
  try {
    return chatDatabase(root, { local: options.local });
  } catch (error) {
    // Zod and parse errors can echo .env.cloudflare values; say what to check instead.
    console.error(
      error instanceof ChatTargetError
        ? `${command}: ${error.message}`
        : `${command}: needs wrangler.jsonc (npm run setup) and CLOUDFLARE_ACCOUNT_ID in .env.cloudflare matching it, or --local.`,
    );
    process.exitCode = 1;
    return undefined;
  }
}
