import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.mjs';

// R-OPS-04 step 4 / R-PLAT-13: the gitignored wrangler.jsonc, rendered from
// wrangler.jsonc.example. setup owns the account, the name, the D1 and R2
// bindings and preview URLs; the example owns the release keys (RELEASE_KEYS) and
// the Durable Object bindings and migration tags it lists, which a rerun appends
// when missing. Everything an owner added (vars of their own, routes for a
// custom domain, extra entries, `workers_dev: false`) is kept.

/** Keys a release may change, so a rerun after an update takes them from the example. */
export const RELEASE_KEYS = ['main', 'compatibility_date', 'compatibility_flags', 'assets'];

/** R-AUTH-05: the Worker vars that come from `.env.cloudflare`; empty until Access exists. */
export const ACCESS_VARS = /** @type {const} */ (['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']);

/**
 * @typedef {Record<string, any>} WorkerConfig
 * @typedef {{ example: WorkerConfig; existing: WorkerConfig | null; accountId: string; slug: string; databaseId: string; env: Record<string, string> }} RenderInput
 */

/** @param {RenderInput} input @returns {WorkerConfig} */
export function renderWorkerConfig({ example, existing, accountId, slug, databaseId, env }) {
  const base = { ...example, ...existing };
  for (const key of RELEASE_KEYS) {
    if (key in example) base[key] = example[key];
  }
  const rooms = example.durable_objects?.bindings ?? [];
  return withAccessVars(
    {
      ...base,
      name: slug,
      account_id: accountId,
      // First generation turns workers.dev on; an owner's `false` (the custom-domain
      // fallback, R-OPS-16) survives a rerun.
      workers_dev: existing?.workers_dev ?? true,
      // R-AUTH-02: preview hostnames would sit outside the Access application.
      preview_urls: false,
      d1_databases: withBinding(base.d1_databases, 'binding', {
        binding: 'DB',
        database_name: `${slug}-db`,
        database_id: databaseId,
        migrations_dir: 'migrations',
      }),
      r2_buckets: withBinding(base.r2_buckets, 'binding', {
        binding: 'MEDIA',
        bucket_name: `${slug}-media`,
      }),
      durable_objects: {
        ...example.durable_objects,
        ...existing?.durable_objects,
        bindings: appendMissing(existing?.durable_objects?.bindings, rooms, 'name'),
      },
      // Durable Object migration tags are append-only: never removed or reordered.
      migrations: appendMissing(existing?.migrations, example.migrations ?? [], 'tag'),
    },
    env,
  );
}

/**
 * The existing entries in their order, then the example's entries whose `key`
 * none of them has.
 * @param {unknown} existing @param {Record<string, unknown>[]} wanted @param {string} key
 * @returns {Record<string, unknown>[]}
 */
function appendMissing(existing, wanted, key) {
  const current = Array.isArray(existing) ? existing : [];
  const have = new Set(current.map((entry) => entry?.[key]));
  return [...current, ...wanted.filter((entry) => !have.has(entry?.[key]))];
}

/**
 * The Access vars as `.env.cloudflare` names them (R-AUTH-05); a value the file
 * leaves empty keeps what the config already holds.
 * @param {WorkerConfig} config @param {Record<string, string>} env @returns {WorkerConfig}
 */
export function withAccessVars(config, env) {
  /** @type {Record<string, string>} */
  const vars = { ...Object.fromEntries(ACCESS_VARS.map((name) => [name, ''])), ...config.vars };
  for (const name of ACCESS_VARS) {
    const value = env[name]?.trim();
    if (value) vars[name] = value;
  }
  return { ...config, vars };
}

/**
 * @param {unknown} list @param {string} key @param {Record<string, string>} entry
 * @returns {Record<string, string>[]}
 */
function withBinding(list, key, entry) {
  const entries = Array.isArray(list) ? list : [];
  const index = entries.findIndex((item) => item?.[key] === entry[key]);
  if (index === -1) return [...entries, entry];
  return entries.map((item, at) => (at === index ? { ...item, ...entry } : item));
}

/** @param {WorkerConfig} config */
export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The repo's wrangler.jsonc, or null when it does not exist yet.
 * @param {string} root @returns {WorkerConfig | null}
 */
export function readWorkerConfig(root) {
  const path = join(root, 'wrangler.jsonc');
  if (!existsSync(path)) return null;
  try {
    return parseJsonc(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSONC; fix or remove it, then run npm run setup.`);
  }
}

/**
 * Every hostname the Worker answers on (R-AUTH-02): workers.dev unless switched
 * off, plus each custom domain or route host.
 * @param {WorkerConfig} config @param {string | null} subdomain
 * @returns {string[]} `null` subdomain leaves the workers.dev host out
 */
export function knownHostnames(config, subdomain) {
  const hosts = [];
  if (config.workers_dev !== false && subdomain)
    hosts.push(`${config.name}.${subdomain}.workers.dev`);
  for (const route of Array.isArray(config.routes) ? config.routes : []) {
    const pattern = typeof route === 'string' ? route : route?.pattern;
    const host =
      typeof pattern === 'string' ? pattern.replace(/^https?:\/\//, '').split('/')[0] : '';
    if (host && !host.includes('*') && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** R-AUTH-03: `my-team`, `my-team.cloudflareaccess.com` or its URL, as the bare host. */
export function teamHost(/** @type {string | undefined} */ value) {
  const host = (value ?? '')
    .trim()
    .replace(/^https:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!host) return '';
  return host.includes('.') ? host : `${host}.cloudflareaccess.com`;
}

/** The hostname of a redirect target, or '' when it is not an absolute URL. */
export function hostOf(/** @type {string} */ location) {
  try {
    return new URL(location).hostname;
  } catch {
    return '';
  }
}
