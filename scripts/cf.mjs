#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env.cloudflare');
const configPath = join(root, 'wrangler.jsonc');
const examplePath = join(root, 'wrangler.jsonc.example');
const wranglerBin = process.env.CF_WRANGLER_BIN ?? join(root, 'node_modules', '.bin', 'wrangler');
const accountIdPattern = /^[0-9a-f]{32}$/;

/**
 * @typedef {{ accounts?: { id?: string }[] }} WhoamiInfo
 */

const args = process.argv.slice(2);
if (args.length === 0) {
  fail('usage: node scripts/cf.mjs <wrangler args...>');
}

const isDeploy = args[0] === 'deploy';
const isCheckDeploy = args[0] === '--check-deploy' && args.length === 1;
const isApi = args[0] === 'api';
const isD1Query = args[0] === 'd1-query';
const isDryRun = isDeploy && isLocalDryRun(args);

// R-PLAT-12: a remote command may not choose another config, environment or
// account; the guard always checks the repo's wrangler.jsonc.
if (!isDryRun) refuseTargetFlags(args);

const env = readEnvFile(envPath);
const accountId = env?.CLOUDFLARE_ACCOUNT_ID;
const token = env?.CLOUDFLARE_API_TOKEN;

if (!isDryRun) {
  if (!env) {
    fail(
      `.env.cloudflare not found at ${envPath}. Copy .env.cloudflare.example and fill in CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.`,
    );
  }
  if (!accountId) fail('CLOUDFLARE_ACCOUNT_ID is missing from .env.cloudflare.');
  if (!token) fail('CLOUDFLARE_API_TOKEN is missing from .env.cloudflare.');
  if (!accountIdPattern.test(accountId)) {
    fail('CLOUDFLARE_ACCOUNT_ID must be a 32-character lowercase hexadecimal account id.');
  }
}

const childEnv = isolatedChildEnv();
stripCloudflareEnv(childEnv);

// A local dry-run keeps the stripped env, so an inherited login or token never reaches it.
if (!isDryRun) {
  childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
  childEnv.CLOUDFLARE_API_TOKEN = token;
}

if (!isDryRun) {
  verifyAccount(/** @type {string} */ (accountId));
}

// R-PLAT-12 / R-OPS-08 / AC-OPS-03: wrangler prefers the config's account_id, so
// every remote command (not only deploy) refuses when wrangler.jsonc names an
// account other than the guarded one. A real deploy and `--check-deploy` also
// require the file and its account_id; other commands check it when present.
const mustHaveConfig = (isDeploy && !isDryRun) || isCheckDeploy || isD1Query;
if (mustHaveConfig || (!isDryRun && existsSync(configPath))) {
  const config = readWranglerConfig(configPath);
  if (!config) {
    fail(`wrangler.jsonc is missing at ${configPath}. Run the setup step first.`);
  }
  const configured = config.account_id;
  if (!configured && mustHaveConfig) {
    fail(`wrangler.jsonc at ${configPath} has no account_id. Run the setup step first.`);
  }
  const envAccountIds = Object.values(config.env ?? {})
    .map((section) => section?.account_id)
    .filter((value) => Boolean(value));
  if (envAccountIds.some((value) => value !== accountId)) {
    fail(
      `wrangler.jsonc has an env.*.account_id that differs from the .env.cloudflare account ${accountId}; refusing to run.`,
    );
  }
  if (configured && configured !== accountId) {
    fail(
      `wrangler.jsonc account_id ${configured} does not match .env.cloudflare account ${accountId}; refusing to run.`,
    );
  }
}

if (isCheckDeploy) {
  process.exit(0);
}

// R-BAK-03: `backup` exports the bound database only, whole, in exactly one shape; no other
// flag (a table filter, a schema-only dump) reaches wrangler.
if (
  args[0] === 'd1' &&
  args[1] === 'export' &&
  (args.length !== 6 ||
    args[2] !== 'DB' ||
    args[3] !== '--remote' ||
    args[4] !== '--output' ||
    !args[5] ||
    args[5].startsWith('-'))
) {
  fail('d1 export may only run as: d1 export DB --remote --output <file>.');
}

if (isD1Query) {
  await d1Query(args, /** @type {string} */ (accountId), /** @type {string} */ (token));
}

if (isApi) {
  await apiGet(args, /** @type {string} */ (accountId), /** @type {string} */ (token));
}

let runArgs = args;
if (isDryRun && !existsSync(configPath)) {
  runArgs = [...args, '--config', renderDryRunConfig()];
}
// Wrangler resolves a relative --outdir against the config file's directory,
// which is `.wrangler/tmp/` for a rendered dry-run config. Make it absolute so
// callers get the bundle where they asked for it.
runArgs = absoluteOutdir(runArgs);

const result = spawnSync(wranglerBin, runArgs, {
  cwd: root,
  env: childEnv,
  stdio: 'inherit',
  timeout: 15 * 60 * 1000,
});

if (result.error) fail(`cannot run wrangler at ${wranglerBin}: ${result.error.message}`);
process.exit(result.status ?? 1);

/** @param {string[]} argv @returns {boolean} */
function isLocalDryRun(argv) {
  if (argv[0] !== 'deploy') return false;
  if (argv.filter((arg) => arg === '--dry-run').length !== 1) return false;

  const rest = argv.slice(1).filter((arg) => arg !== '--dry-run');
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--outdir') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) return false;
      index += 1;
      continue;
    }
    if (arg.startsWith('--outdir=')) {
      if (arg.length === '--outdir='.length) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** @param {string[]} argv */
function refuseTargetFlags(argv) {
  // yargs accepts `--envFile`, `--e`, `--c=x` and grouped short flags (`-vc x`),
  // so compare the normalised name, not the spelling.
  const forbidden = new Set(['config', 'c', 'env', 'e', 'cwd', 'env-file']);
  for (const arg of argv) {
    if (!arg.startsWith('-') || arg === '-' || arg === '--') continue;
    const name = arg
      .replace(/^-+/, '')
      .split('=')[0]
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
    // `-cfoo` / `-estaging` / `-vc`: a single-dash group containing c or e.
    const shortGroup = !arg.startsWith('--') && /[ce]/.test(arg.slice(1).split('=')[0]);
    if (forbidden.has(name) || shortGroup) {
      fail(
        `${arg.split('=')[0]} is not allowed outside a local dry-run; the guard only certifies wrangler.jsonc.`,
      );
    }
  }
}

function isolatedChildEnv() {
  const cfHome = join(root, '.wrangler', 'cf-home');
  const home = join(cfHome, 'home');
  const configHome = join(cfHome, 'config');
  const cacheHome = join(cfHome, 'cache');
  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(cacheHome, { recursive: true });

  const childEnv = { ...process.env };
  delete childEnv.CF_WRANGLER_BIN;
  // Wrangler 4 reads its global config from XDG_CONFIG_HOME on macOS, but falls
  // back to the legacy $HOME/.wrangler when that directory exists. Moving both
  // guarantees a machine-wide `wrangler login` cannot be picked up by a child.
  childEnv.HOME = home;
  childEnv.XDG_CONFIG_HOME = configHome;
  childEnv.XDG_CACHE_HOME = cacheHome;
  return childEnv;
}

/** @param {NodeJS.ProcessEnv} target */
function stripCloudflareEnv(target) {
  for (const key of Object.keys(target)) {
    if (key.startsWith('CLOUDFLARE_')) delete target[key];
  }
}

/** @param {string} expected */
function verifyAccount(expected) {
  const check = spawnSync(wranglerBin, ['whoami', '--json'], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    timeout: 2 * 60 * 1000,
  });
  if (check.error) fail(`cannot run wrangler at ${wranglerBin}: ${check.error.message}`);
  if (check.status !== 0) {
    fail(`wrangler whoami failed with exit code ${check.status}; refusing to run.`);
  }

  /** @type {WhoamiInfo} */
  let info;
  try {
    info = /** @type {WhoamiInfo} */ (JSON.parse(check.stdout));
  } catch {
    fail('wrangler whoami --json returned invalid JSON; refusing to run.');
  }
  const accounts = Array.isArray(info?.accounts) ? info.accounts : [];
  // R-PLAT-13: the token is scoped to one account, so a wider one is a mistake.
  if (accounts.length > 1) {
    fail('wrangler sees more than one account; use an account-scoped API token. Refusing to run.');
  }
  if (!accounts.some((entry) => entry?.id === expected)) {
    fail(`wrangler cannot see account ${expected}; refusing to run.`);
  }
}

/** @param {string} path @returns {Record<string, string> | null} */
function readEnvFile(path) {
  if (!existsSync(path)) return null;

  /** @type {Record<string, string>} */
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** @param {string[]} args @returns {string[]} */
function absoluteOutdir(args) {
  const flag = args.indexOf('--outdir');
  if (flag !== -1 && args[flag + 1] && !isAbsolute(args[flag + 1])) {
    const next = [...args];
    next[flag + 1] = join(root, args[flag + 1]);
    return next;
  }

  const prefix = args.findIndex((arg) => arg.startsWith('--outdir='));
  if (prefix !== -1) {
    const next = [...args];
    next[prefix] = `--outdir=${join(root, args[prefix].slice('--outdir='.length))}`;
    return next;
  }

  return args;
}

/**
 * @typedef {{ account_id?: string, d1_databases?: { binding?: string, database_id?: string }[], env?: Record<string, { account_id?: string } | undefined> }} WranglerConfig
 */

/**
 * @param {string} path
 * @returns {WranglerConfig | undefined}
 */
function readWranglerConfig(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(readFileSync(path, 'utf8'))));
  } catch {
    fail(`wrangler.jsonc at ${path} could not be parsed (not valid JSONC); refusing to run.`);
  }
}

/** @param {string} source @returns {string} */
function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

/** @param {string} source @returns {string} */
function stripTrailingCommas(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    output += char;
  }
  return output;
}

function renderDryRunConfig() {
  if (!existsSync(examplePath)) fail(`template ${examplePath} not found.`);

  let config;
  try {
    config = JSON.parse(readFileSync(examplePath, 'utf8'));
  } catch {
    fail('wrangler.jsonc.example is not valid JSON.');
  }

  // Dry-run builds locally, so it always uses a placeholder account rather
  // than writing the guarded account id into a temporary file.
  config.account_id = '00000000000000000000000000000000';
  // Paths resolve relative to the config file, so the rendered copy needs
  // absolute paths back to the source tree and the adapter output.
  config.main = join(root, 'src', 'worker.ts');
  if (config.assets) config.assets.directory = join(root, '.svelte-kit', 'cloudflare');

  const dir = join(root, '.wrangler', 'tmp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'wrangler.dry-run.jsonc');
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/**
 * `cf.mjs api [--put] /<path>`: one call under the guarded account, for what no CLI
 * command reports as data (the workers.dev subdomain, a bucket's domains, the Access
 * policy). GET by default; `--put` sends stdin as the JSON body and is allowed for the
 * Access policy path only (R-AUTH-18). The token rides only in this process's request
 * header; stdout gets the `result`.
 * @param {string[]} argv @param {string} account @param {string} apiToken
 * @returns {Promise<never>}
 */
async function apiGet(argv, account, apiToken) {
  const put = argv[1] === '--put';
  const write = put;
  const method = put ? 'PUT' : 'GET';
  const path = argv[write ? 2 : 1] ?? '';
  const policy = /^\/access\/(?:apps\/[A-Za-z0-9_-]{1,64}\/)?policies\/[A-Za-z0-9_-]{1,64}$/;
  // Only the reads the scripts make: the workers.dev subdomain, one bucket by name
  // (R2 names: lower-case letters, digits, hyphens), that bucket's domains, and the
  // Access policy (read, and written with --put).
  const shapes = [
    /^\/workers\/subdomain$/,
    /^\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}$/,
    /^\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}\/domains\/(?:managed|custom)$/,
    policy,
  ];
  const allowed = put ? policy.test(path) : shapes.some((shape) => shape.test(path));
  if (argv.length !== (write ? 3 : 2) || !allowed) {
    fail(
      'usage: node scripts/cf.mjs api /workers/subdomain | /r2/buckets/<name>[/domains/managed|custom] | /access/[apps/<id>/]policies/<id> | --put /access/[apps/<id>/]policies/<id>',
    );
  }
  let payload;
  if (write) {
    payload = readFileSync(0, 'utf8');
    try {
      JSON.parse(payload);
    } catch {
      fail(`${argv[1]} needs a JSON body on stdin.`);
    }
  }
  let response;
  try {
    response = await fetch(`${apiBase()}/client/v4/accounts/${account}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(write ? { 'content-type': 'application/json' } : {}),
      },
      ...(write ? { body: payload } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`${method} ${path} failed: ${error instanceof Error ? error.name : 'network error'}`);
  }
  /** @type {{ success?: boolean; result?: unknown; errors?: { code?: number }[] } | null} */
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const codes = (body?.errors ?? []).map((entry) => entry?.code).filter(Boolean);
    fail(
      `${method} ${path} failed: HTTP ${response.status}${codes.length ? ` (${codes.join(', ')})` : ''}`,
    );
  }
  process.stdout.write(`${JSON.stringify(body.result ?? null)}\n`);
  process.exit(0);
}

/** R-MEM-11: one guarded statement, only against the DB binding and maintenance tables.
 * @param {string[]} argv @param {string} account @param {string} apiToken
 * @returns {Promise<never>}
 */
async function d1Query(argv, account, apiToken) {
  const config = readWranglerConfig(configPath);
  const id = config?.d1_databases?.find(
    (/** @type {{binding?: string}} */ entry) => entry.binding === 'DB',
  )?.database_id;
  if (
    argv.length !== 2 ||
    !id ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
    argv[1] !== id
  )
    fail('d1-query may only target the database_id bound as DB in wrangler.jsonc.');
  let body;
  try {
    body = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    fail('d1-query needs SQL and params as JSON on stdin.');
  }
  if (
    !body ||
    Array.isArray(body) ||
    typeof body.sql !== 'string' ||
    !Array.isArray(body.params) ||
    Object.keys(body).some((key) => !['sql', 'params'].includes(key)) ||
    body.params.some(
      (/** @type {unknown} */ value) =>
        value !== null &&
        typeof value !== 'string' &&
        (typeof value !== 'number' || !Number.isFinite(value)),
    )
  )
    fail('d1-query needs one {sql, params} statement.');
  // This deliberately accepts a small SQL subset. Strip literal contents before checking
  // syntax, unquote identifiers, and reject comma joins as well as qualified table names.
  const sql = body.sql
    .replace(/'(?:''|[^'])*'/g, " '' ")
    .replace(/"([a-z_][a-z0-9_]*)"/gi, ' $1 ')
    .replace(/\s*\.\s*/g, '.')
    .trim()
    .replace(/;$/, '');
  const references = [...sql.matchAll(/\b(from|join|update|into)\b\s*/gi)];
  const tables = references.map(
    (match) =>
      /^[a-z_][a-z0-9_.]*/i.exec(sql.slice(match.index + match[0].length))?.[0].toLowerCase() ?? '',
  );
  const commaJoin = references.some(
    (match) =>
      /^(?:from|join)$/i.test(match[1]) &&
      sql
        .slice(match.index + match[0].length)
        .split(/\b(?:where|order|limit|join|group|having|union|returning|set|on)\b|\)/i)[0]
        .includes(','),
  );
  if (
    !/^(?:select|update|delete|insert)\b/i.test(sql) ||
    /[;`[\]]|--|\/\*|"/.test(sql) ||
    /\b(?:drop|alter|create|pragma|attach|detach|replace|with|load_extension)\b/i.test(sql) ||
    commaJoin ||
    !tables.length ||
    tables.some(
      (table) =>
        !['upload_reservations', 'media', 'storage_usage', 'schema_meta', 'backup_runs'].includes(
          table,
        ),
    ) ||
    // R-BAK-09: backup_runs takes one plain INSERT from backup, nothing else.
    (tables.includes('backup_runs') &&
      (tables.length !== 1 || !/^insert\s+into\s+backup_runs\s*\(/i.test(sql)))
  )
    fail('d1-query permits SELECT/UPDATE/DELETE/INSERT on housekeeping tables only.');
  let response;
  try {
    response = await fetch(`${apiBase()}/client/v4/accounts/${account}/d1/database/${id}/raw`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail('D1 housekeeping query failed.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success)
    fail(`D1 housekeeping query failed: HTTP ${response.status}`);
  process.stdout.write(`${JSON.stringify(result.result)}\n`);
  process.exit(0);
}

function apiBase() {
  const override = process.env.CF_API_BASE;
  if (override === undefined) return 'https://api.cloudflare.com';
  // Tests point this at a loopback fake; nothing else may receive the token.
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override)) {
    fail('CF_API_BASE may only name http://127.0.0.1:<port>.');
  }
  return override;
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`cf.mjs: ${message}`);
  process.exit(1);
}
