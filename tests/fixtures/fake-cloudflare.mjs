#!/usr/bin/env node
// A stateful stand-in for the wrangler CLI behind scripts/cf.mjs (CF_WRANGLER_BIN)
// and for the API reads of `cf.mjs api`: D1 databases are SQLite files, buckets,
// secrets and bucket domains live in a JSON state file. Scripts run end to end
// through the real cf.mjs (the CLI entry below, FAKE_CF_STATE), or in process with
// `fakeCli`/`fakeApi` for unit tests (AC-OPS-01, 04, 05).
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{
 *   databases: { name: string; uuid: string }[];
 *   buckets: string[];
 *   secrets: Record<string, string>;
 *   worker: boolean;
 *   calls: string[][];
 *   subdomain?: string;
 *   devUrl?: Record<string, boolean>;
 *   customDomains?: Record<string, string[]>;
 *   failures?: Record<string, string>;
 *   deployments?: { id: string; created_on: string }[];
 *   workerCreatedAt?: string;
 * }} FakeState
 * @typedef {{ stateDir: string; cwd: string; account: string; input?: string }} FakeContext
 * @typedef {{ status: number; stdout: string; stderr: string }} FakeResult
 */

/** @param {string} stateDir @returns {FakeState} */
export function loadState(stateDir) {
  const path = join(stateDir, 'state.json');
  return existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { databases: [], buckets: [], secrets: {}, worker: false, calls: [] };
}

class Failure extends Error {}

/** Splits on `;` outside quoted strings. @param {string} sql */
function statements(sql) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    if (char === ';' && !quoted) {
      if (current.trim()) out.push(current);
      current = '';
    } else current += char;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** @param {string[]} args @param {FakeContext} context @returns {FakeResult} */
export function fakeCli(args, context) {
  const state = loadState(context.stateDir);
  state.calls.push(args);
  let stdout = '';
  let status = 0;
  let stderr = '';
  try {
    stdout = dispatch(args, context, state);
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    status = 1;
    stderr = `✘ [ERROR] ${error.message}\n`;
  }
  writeFileSync(join(context.stateDir, 'state.json'), JSON.stringify(state, null, 2));
  return { status, stdout, stderr };
}

/** @param {string[]} args @param {FakeContext} context @param {FakeState} state */
function dispatch(args, context, state) {
  const config = () => {
    const path = join(context.cwd, 'wrangler.jsonc');
    if (!existsSync(path)) throw new Failure('no config file');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const database = () => {
    const entry = config().d1_databases?.find((/** @type {any} */ db) => db.binding === 'DB');
    const known = state.databases.find((db) => db.uuid === entry?.database_id);
    if (!known) throw new Failure(`Couldn't find DB with name '${args[2]}'`);
    const db = new Database(join(context.stateDir, `${known.uuid}.sqlite`));
    db.pragma('foreign_keys = ON');
    return { db, migrationsDir: entry.migrations_dir ?? 'migrations' };
  };
  const command = args.slice(0, 2).join(' ');
  const failure = state.failures?.[command];
  if (failure) throw new Failure(failure);

  if (args[0] === 'whoami') return JSON.stringify({ accounts: [{ id: context.account }] });
  if (command === 'd1 list') return JSON.stringify(state.databases);
  if (command === 'deployments list') {
    if (state.deployments) return JSON.stringify(state.deployments);
    // As the real API answers before the Worker's first upload…
    if (!state.worker)
      throw new Failure(
        'A request to the Cloudflare API failed.\n\n  This Worker does not exist on your account. [code: 10007]',
      );
    // …and after it: `secret put` on a missing Worker uploads one, which is a deployment.
    return JSON.stringify([{ id: 'secret-put-upload', created_on: state.workerCreatedAt }]);
  }
  if (command === 'd1 create') {
    const name = args[2] ?? '';
    if (state.databases.some((db) => db.name === name)) {
      throw new Failure('A database with that name already exists');
    }
    const uuid = `00000000-0000-4000-8000-${String(state.databases.length + 1).padStart(12, '0')}`;
    state.databases.push({ name, uuid });
    return `✅ Successfully created DB '${name}'\n`;
  }
  if (command === 'd1 execute') {
    const { db } = database();
    const sql = args[args.indexOf('--command') + 1] ?? '';
    try {
      const results = statements(sql).map((text) => {
        const statement = db.prepare(text);
        return {
          results: statement.reader ? statement.all() : (statement.run(), []),
          success: true,
        };
      });
      return JSON.stringify(results);
    } catch (error) {
      throw new Failure(error instanceof Error ? error.message : 'sql error');
    } finally {
      db.close();
    }
  }
  if (command === 'd1 migrations') {
    const { db, migrationsDir } = database();
    db.exec(
      'create table if not exists d1_migrations (id integer primary key autoincrement, name text unique, applied_at timestamp default current_timestamp not null)',
    );
    const applied = new Set(db.prepare('select name from d1_migrations').pluck().all());
    const files = readdirSync(join(context.cwd, migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files.filter((name) => !applied.has(name))) {
      db.exec(readFileSync(join(context.cwd, migrationsDir, file), 'utf8'));
      db.prepare('insert into d1_migrations (name) values (?)').run(file);
    }
    db.close();
    return '✅ Migrations applied\n';
  }
  if (command === 'r2 bucket' && args[2] === 'create') {
    const name = args[3] ?? '';
    if (state.buckets.includes(name)) {
      throw new Failure('The bucket you tried to create already exists');
    }
    state.buckets.push(name);
    return `Created bucket '${name}'\n`;
  }
  if (command === 'secret list') {
    const { name } = config();
    if (!state.worker) throw new Failure(`Worker "${name}" not found.`);
    return JSON.stringify(
      Object.keys(state.secrets).map((key) => ({ name: key, type: 'secret_text' })),
    );
  }
  if (command === 'secret put') {
    config();
    if (!context.input) throw new Failure('empty secret');
    state.secrets[args[2] ?? ''] = context.input;
    if (!state.worker) state.workerCreatedAt = new Date().toISOString();
    state.worker = true;
    return `✨ Success! Uploaded secret ${args[2]}\n`;
  }
  throw new Failure(`fake does not know: ${args.join(' ')}`);
}

/**
 * The account-relative API GETs scripts make through `cf.mjs api`.
 * @param {string} path @param {string} stateDir
 * @returns {{ status: number; body: { success: boolean; errors: { code: number }[]; result?: unknown } }}
 */
export function fakeApi(path, stateDir) {
  const state = loadState(stateDir);
  const ok = (/** @type {unknown} */ result) => ({
    status: 200,
    body: { success: true, errors: [], result },
  });
  const missing = (/** @type {number} */ code) => ({
    status: 404,
    body: { success: false, errors: [{ code }] },
  });
  if (path === '/workers/subdomain') {
    return state.subdomain === undefined ? missing(10007) : ok({ subdomain: state.subdomain });
  }
  // Like the real API, the list is paginated: a caller that reads only it misses buckets.
  if (path === '/r2/buckets') {
    return ok({ buckets: state.buckets.slice(0, 20).map((name) => ({ name })) });
  }
  const single = /^\/r2\/buckets\/([^/]+)$/.exec(path);
  if (single) {
    const failure = state.failures?.['api bucket'];
    if (failure) return { status: 403, body: { success: false, errors: [{ code: 10000 }] } };
    return state.buckets.includes(single[1] ?? '')
      ? ok({ name: single[1], creation_date: '2026-11-05T00:00:00Z', location: 'APAC' })
      : missing(10006);
  }
  const bucket = /^\/r2\/buckets\/([^/]+)\/domains\/(managed|custom)$/.exec(path);
  const name = bucket?.[1] ?? '';
  if (bucket && state.buckets.includes(name)) {
    return bucket[2] === 'managed'
      ? ok({ enabled: state.devUrl?.[name] ?? false, domain: `pub-${name}.r2.dev` })
      : ok({ domains: (state.customDomains?.[name] ?? []).map((domain) => ({ domain })) });
  }
  return missing(7003);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = fakeCli(process.argv.slice(2), {
    stateDir: process.env.FAKE_CF_STATE ?? '',
    cwd: process.cwd(),
    account: process.env.FAKE_CF_ACCOUNT ?? '',
    input: process.stdin.isTTY ? '' : readFileSync(0, 'utf8'),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
