// R-OPS-04: `npm run setup`, idempotent. Every Cloudflare call goes through the
// injected runner (cf.mjs in the CLI, INV-9), and the prompts are injected too, so
// tests run the whole flow against a fake CLI and API (AC-OPS-01, AC-PLAT-08).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteDefaults } from '../../site.config.ts';
import { normalizeName } from '../../src/lib/shared/normalize.ts';
import { DESTRUCTIVE_MIGRATION } from './backup-gate.mjs';
import { apiGet, apiLookup, d1Remote, reason } from './cf-child.mjs';
import { readEnvFile } from './env-file.mjs';
import { normalizeEmail, quote, validEmail } from './invite.mjs';
import { parseJsonc } from './jsonc.mjs';
import { compareMigrations, localMigrations, remoteMigrations } from './migrations.mjs';
import {
  readWorkerConfig,
  renderWorkerConfig,
  serializeConfig,
  teamHost,
  vapidPairState,
} from './worker-config.mjs';

/** Worker name rules, short enough that `<slug>-media` is a valid bucket name. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/;
/** R-CHAT-04 and R-AUTH-23: created once, never printed, never rotated by a rerun. */
export const SETUP_SECRETS = ['INTERNAL_CONTEXT_KEY', 'LOG_HASH_SALT'];

/**
 * @typedef {import('./cf-child.mjs').CfRunner} CfRunner
 * @typedef {{
 *   run: CfRunner;
 *   ask: (prompt: { key: 'slug' | 'title' | 'theme' | 'locale' | 'admin'; question: string; fallback: string }) => Promise<string>;
 *   out: (line: string) => void;
 *   root: string;
 *   nodeVersion: string;
 *   uuid: () => string;
 *   secret: () => string;
 *   vapidKeyPair?: () => Promise<{ publicKey: string; privateKey: string }>;
 *   now?: number;
 * }} SetupDeps
 */

/** R-OPS-04 step 5 / R-NTF-01: generates a P-256 key pair for Web Push VAPID on WebCrypto. */
export async function generateVapidKeyPair() {
  const keyPair = /** @type {CryptoKeyPair} */ (
    await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveKey',
    ])
  );
  const pkcs8 = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  );
  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    privateKey: Buffer.from(pkcs8).toString('base64url'),
    publicKey: Buffer.from(rawPub).toString('base64url'),
  };
}

export class SetupError extends Error {
  name = 'SetupError';
}

/** The choices the app admits, read from the files that own them (R-UI-03, R-UI-10). */
export function readChoices(/** @type {string} */ root) {
  const registry = readFileSync(join(root, 'src', 'lib', 'themes', 'registry.ts'), 'utf8');
  const block = /export const themes[^=]*=\s*\{([\s\S]*?)\n\};/.exec(registry)?.[1] ?? '';
  const themes = [...block.matchAll(/^\s*([a-z][a-z0-9-]*):\s*\{/gm)].map((match) => match[1]);
  const i18n = readFileSync(join(root, 'src', 'lib', 'i18n', 'index.ts'), 'utf8');
  const union = /export type Locale = ([^;]+);/.exec(i18n)?.[1] ?? '';
  const locales = [...union.matchAll(/'([a-z]{2})'/g)].map((match) => match[1]);
  if (themes.length === 0 || locales.length === 0) {
    throw new SetupError('cannot read the theme ids or locales from src/lib');
  }
  return { themes: /** @type {string[]} */ (themes), locales: /** @type {string[]} */ (locales) };
}

/**
 * @param {CfRunner} run @param {string[]} args @param {string} what
 * @returns {string}
 */
function must(run, args, what) {
  const result = run(args);
  if (result.status !== 0) throw new SetupError(`${what} failed: ${reason(result)}`);
  return result.stdout;
}

/** @param {CfRunner} run @param {string} name @returns {string | null} */
function findDatabase(run, name) {
  const listed = JSON.parse(must(run, ['d1', 'list', '--json'], 'listing D1 databases'));
  const found = (Array.isArray(listed) ? listed : []).find((db) => db?.name === name);
  return typeof found?.uuid === 'string' ? found.uuid : null;
}

/**
 * The bucket looked up by name (the account's list is paginated): 404 is missing,
 * any other failure stops setup rather than risk a duplicate create.
 * @param {CfRunner} run @param {string} name @returns {boolean}
 */
function bucketExists(run, name) {
  const lookup = apiLookup(run, `/r2/buckets/${name}`);
  if (lookup.found) return true;
  if (lookup.missing) return false;
  throw new SetupError(
    `cannot check R2 bucket ${name} (${lookup.reason}). Activate R2 in the dashboard (it needs a payment method) and check the token has Workers R2 Storage · Edit.`,
  );
}

/** @param {CfRunner} run @returns {Set<string>} */
function listSecrets(run) {
  const result = run(['secret', 'list', '--format', 'json']);
  // The Worker does not exist before its first secret or deploy, so it has none.
  if (result.status !== 0) {
    if (/not found/i.test(`${result.stderr}${result.stdout}`)) return new Set();
    throw new SetupError(`listing Worker secrets failed: ${reason(result)}`);
  }
  const parsed = JSON.parse(result.stdout);
  return new Set((Array.isArray(parsed) ? parsed : []).map((entry) => String(entry?.name)));
}

/** @param {SetupDeps} deps @param {string} slug */
async function workersHostname(deps, slug) {
  const result = /** @type {{ subdomain?: string } | null} */ (
    apiGet(deps.run, '/workers/subdomain')
  );
  return result?.subdomain
    ? `${slug}.${result.subdomain}.workers.dev`
    : `${slug}.<your-subdomain>.workers.dev (register a workers.dev subdomain: Workers & Pages → Overview)`;
}

const BOOTSTRAP = `select u.auth_email as email, u.status, u.access_sub is null as unclaimed from users u join invites i on i.email = u.auth_email and i.invited_by = u.id where u.role = 'admin' order by u.created_at limit 1`;
/** The keys are the site.config.ts fields they override (R-UI-01, R-UI-02). */
const SETTING_KEYS = ['name', 'theme', 'locale'];

/**
 * Step 6: `site_settings` defaults and the bootstrap admin invite. Only what is
 * missing is asked for and written, so a rerun keeps every member and setting.
 * @param {SetupDeps} deps @param {{ themes: string[]; locales: string[] }} choices
 * @returns {Promise<string | null>} the bootstrap admin's email
 */
async function seed(deps, { themes, locales }) {
  const now = deps.now ?? Date.now();
  const [stored = [], [bootstrap] = [], [members] = []] = await d1Remote(deps.run, [
    `select key from site_settings where key in (${SETTING_KEYS.map(quote).join(', ')})`,
    BOOTSTRAP,
    'select count(*) as n from users',
  ]);
  const have = new Set(stored.map((row) => row.key));
  /** @type {[string, string][]} */
  const settings = [['setup_state', 'locked']];
  if (!have.has('name')) {
    const title = (
      await deps.ask({ key: 'title', question: 'Site title', fallback: siteDefaults.name })
    ).trim();
    if (!title || title.length > 80) throw new SetupError('the site title is 1–80 characters.');
    settings.push(['name', title]);
  }
  if (!have.has('theme')) {
    const theme = (
      await deps.ask({
        key: 'theme',
        question: `Default theme (${themes.join(', ')})`,
        fallback: siteDefaults.theme,
      })
    ).trim();
    if (!themes.includes(theme)) throw new SetupError(`the theme is one of ${themes.join(', ')}.`);
    settings.push(['theme', theme]);
  }
  if (!have.has('locale')) {
    const locale = (
      await deps.ask({
        key: 'locale',
        question: `Language (${locales.join(', ')})`,
        fallback: siteDefaults.locale,
      })
    ).trim();
    if (!locales.includes(locale)) {
      throw new SetupError(`the language is one of ${locales.join(', ')}.`);
    }
    settings.push(['locale', locale]);
  }
  /** @type {{ old: string, next: string } | null} */
  let correction = null;
  const statements = [
    // R-AUTH-12: an explicit lock when no state exists; only `npm run unlock` changes it.
    `insert into site_settings (key, value_json, updated_at) values ${settings
      .map(([key, value]) => `(${quote(key)}, ${quote(JSON.stringify(value))}, ${now})`)
      .join(', ')} on conflict (key) do nothing`,
  ];

  const memberCount = Number(members?.n);
  if (!Number.isFinite(memberCount)) throw new SetupError('cannot count the existing members.');
  if (memberCount === 0) {
    const adminEmail = normalizeEmail(
      await deps.ask({ key: 'admin', question: 'Bootstrap admin email', fallback: '' }),
    );
    if (!validEmail(adminEmail)) throw new SetupError(`not an email address: ${adminEmail}`);
    const userId = quote(deps.uuid());
    const inviteId = quote(deps.uuid());
    const email = quote(adminEmail);
    const name = adminEmail.split('@')[0] ?? 'admin';
    const ours = `exists (select 1 from users where id = ${userId})`;
    statements.push(
      // R-AUTH-12: the bootstrap admin names themselves as inviter. The guard repeats
      // the empty-table check, so a member added meanwhile is never overwritten.
      `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) select ${userId}, ${email}, ${quote(name)}, ${quote(normalizeName(name))}, 'admin', 'invited', ${now}, ${now} where not exists (select 1 from users)`,
      // No expiry: Access may take days to configure, and nobody else can re-invite them.
      `insert into invites (id, email, invited_by, role, status, created_at, expires_at) select ${inviteId}, ${email}, ${userId}, 'admin', 'pending', ${now}, NULL where ${ours}`,
      `insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) select ${quote(deps.uuid())}, ${userId}, 'invite.created', 'invite', ${inviteId}, ${now} where ${ours}`,
    );
  }
  // R-OPS-04 step 6: a mistyped bootstrap email can be corrected until that admin has
  // signed in (still `invited`, no Access subject). Both rows change in one batch, each
  // guarded on those two conditions, so a claimed or active admin is never touched.
  if (memberCount > 0 && bootstrap?.status === 'invited' && Number(bootstrap.unclaimed) === 1) {
    const current = String(bootstrap.email);
    const replacement = normalizeEmail(
      await deps.ask({
        key: 'admin',
        question: `Bootstrap admin email (has not signed in yet; keep or replace)`,
        fallback: current,
      }),
    );
    if (!validEmail(replacement)) throw new SetupError(`not an email address: ${replacement}`);
    if (replacement !== current) {
      // Refuse before any write; never let the unique index answer.
      const [taken = []] = await d1Remote(deps.run, [
        `select 1 as taken from users where auth_email = ${quote(replacement)} union all select 1 from invites where email = ${quote(replacement)}`,
      ]);
      if (taken.length > 0) {
        throw new SetupError(
          `${replacement} already belongs to another member or invite; choose another bootstrap admin email.`,
        );
      }
      const old = quote(current);
      const next = quote(replacement);
      const oldName = current.split('@')[0] ?? 'admin';
      const newName = replacement.split('@')[0] ?? 'admin';
      const unclaimed = `u.auth_email = ${old} and u.role = 'admin' and u.status = 'invited' and u.access_sub is null`;
      statements.push(
        `update users as u set auth_email = ${next}, display_name = case when display_name = ${quote(oldName)} then ${quote(newName)} else display_name end, display_name_norm = case when display_name = ${quote(oldName)} then ${quote(normalizeName(newName))} else display_name_norm end, updated_at = ${now} where ${unclaimed} and exists (select 1 from invites i where i.email = ${old} and i.invited_by = u.id and i.status = 'pending')`,
        `update invites set email = ${next}, access_synced_at = NULL where email = ${old} and status = 'pending' and invited_by in (select id from users where auth_email = ${next} and role = 'admin' and status = 'invited' and access_sub is null)`,
      );
      correction = { old: current, next: replacement };
    }
  }
  statements.push(BOOTSTRAP);
  const results = await d1Remote(deps.run, statements);
  if (correction) {
    // The old address may still be in the Access policy; the invite is no longer marked synced.
    deps.out(
      `The Access policy still lists ${correction.old}: run npm run invite -- remove ${correction.old}, then npm run invite -- add ${correction.next}.`,
    );
  }
  const email = results.at(-1)?.[0]?.email ?? bootstrap?.email;
  return typeof email === 'string' ? email : null;
}

/** @param {SetupDeps} deps @returns {Promise<0>} */
export async function runSetup(deps) {
  const { run, out, root } = deps;

  // 1. Node, .env.cloudflare, the token's access (cf.mjs checks it on every call), wrangler.jsonc.
  if (Number(deps.nodeVersion.split('.')[0]) < 24) {
    throw new SetupError(`Node.js 24 or newer is required (found ${deps.nodeVersion}).`);
  }
  const envPath = join(root, '.env.cloudflare');
  if (!existsSync(envPath)) {
    throw new SetupError(
      'copy .env.cloudflare.example to .env.cloudflare and fill CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
    );
  }
  const env = readEnvFile(envPath) ?? {};
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const configPath = join(root, 'wrangler.jsonc');
  let existing;
  try {
    existing = readWorkerConfig(root);
  } catch (error) {
    throw new SetupError(/** @type {Error} */ (error).message);
  }
  if (existing?.account_id && existing.account_id !== accountId) {
    throw new SetupError(
      `wrangler.jsonc names account ${existing.account_id} but .env.cloudflare names ${accountId}; make them agree first (R-PLAT-13).`,
    );
  }
  must(run, ['whoami'], 'checking the token can see the account');
  out(`Account ${accountId}: the token can see it.`);

  // 2. The answers. The slug comes first (it names every resource); the site
  // settings and admin are asked in step 6, and only while D1 lacks them.
  const { themes, locales } = readChoices(root);
  const slug = (
    await deps.ask({
      key: 'slug',
      question: 'Project slug (Worker name)',
      fallback: existing?.name ?? 'classhub',
    })
  ).trim();
  if (!SLUG.test(slug)) {
    throw new SetupError('the slug is 1–54 lower-case letters, digits or hyphens.');
  }

  // 3. D1 and R2: listed first, created only when missing, never deleted.
  const dbName = `${slug}-db`;
  let databaseId = findDatabase(run, dbName);
  const reused = Boolean(databaseId);
  if (databaseId) out(`D1 ${dbName}: exists, reused.`);
  else {
    must(run, ['d1', 'create', dbName, '--update-config=false'], `creating D1 ${dbName}`);
    databaseId = findDatabase(run, dbName);
    if (!databaseId) throw new SetupError(`D1 ${dbName} was created but is not listed.`);
    out(`D1 ${dbName}: created.`);
  }
  const bucket = `${slug}-media`;
  if (bucketExists(run, bucket)) out(`R2 ${bucket}: exists, reused.`);
  else {
    // A private bucket: no r2.dev URL and no custom domain (AC-MEM-08).
    must(run, ['r2', 'bucket', 'create', bucket, '--update-config=false'], `creating R2 ${bucket}`);
    out(`R2 ${bucket}: created.`);
  }

  // 4. The generated, gitignored config (R-PLAT-13).
  const example = parseJsonc(readFileSync(join(root, 'wrangler.jsonc.example'), 'utf8'));
  const config = renderWorkerConfig({ example, existing, accountId, slug, databaseId, env });
  const rendered = serializeConfig(config);
  if (!existsSync(configPath) || readFileSync(configPath, 'utf8') !== rendered) {
    writeFileSync(configPath, rendered);
    out('wrangler.jsonc: written.');
  } else out('wrangler.jsonc: unchanged.');

  // 5. Secrets, only when missing; the value goes in on stdin and is never shown.
  // `secret list` needs the written config, so the VAPID refusal comes right after it and
  // before any put: a new pair would silence every subscribed device.
  const present = listSecrets(run);
  const vapidState = vapidPairState(config, present.has('VAPID_PRIVATE_KEY'));
  if (vapidState === 'var-missing') {
    throw new SetupError(
      'the VAPID_PRIVATE_KEY secret exists but VAPID_PUBLIC_KEY is empty in wrangler.jsonc. A new pair would silence every subscribed device. Put the deployed public key back into vars (Worker settings in the dashboard, or GET /api/v1/notifications) and rerun setup.',
    );
  }
  for (const name of SETUP_SECRETS) {
    if (present.has(name)) {
      out(`Secret ${name}: exists, kept.`);
      continue;
    }
    const result = run(['secret', 'put', name], { input: deps.secret() });
    if (result.status !== 0)
      throw new SetupError(`storing secret ${name} failed: ${reason(result)}`);
    out(`Secret ${name}: created.`);
  }

  // R-OPS-04 step 5 / R-NTF-01: generate a VAPID P-256 key pair when VAPID_PUBLIC_KEY is empty.
  // A rerun never replaces an existing pair.
  if (vapidState === 'both') {
    out('VAPID key pair: exists, kept.');
  } else if (vapidState === 'secret-missing') {
    out(
      'VAPID key pair: WARNING VAPID_PUBLIC_KEY is set but the VAPID_PRIVATE_KEY secret is missing; push stays off. Restore the secret, or empty the var to generate a new pair (existing devices must then subscribe again).',
    );
  } else {
    const vapid = await (deps.vapidKeyPair ?? generateVapidKeyPair)();
    const secretRes = run(['secret', 'put', 'VAPID_PRIVATE_KEY'], { input: vapid.privateKey });
    if (secretRes.status !== 0) {
      throw new SetupError(`storing secret VAPID_PRIVATE_KEY failed: ${reason(secretRes)}`);
    }
    config.vars = { ...config.vars, VAPID_PUBLIC_KEY: vapid.publicKey };
    writeFileSync(configPath, serializeConfig(config));
    out('VAPID key pair: created.');
  }

  // 6. Remote migrations, then the defaults (never demo content). On a database already in
  // use a destructive step waits for db:migrate:remote and its backup gate (INV-7, R-DB-11).
  const local = localMigrations(
    root,
    config.d1_databases?.find((/** @type {{ binding?: string }} */ db) => db.binding === 'DB')
      ?.migrations_dir,
  );
  if (reused && local.some((name) => DESTRUCTIVE_MIGRATION.test(name))) {
    let pending;
    try {
      pending = compareMigrations(local, await remoteMigrations(run)).pending;
    } catch {
      pending = local;
    }
    const destructive = pending.filter((name) => DESTRUCTIVE_MIGRATION.test(name));
    if (destructive.length > 0)
      throw new SetupError(
        `${destructive.join(', ')} is destructive; setup never applies it. Run npm run backup, then npm run db:migrate:remote.`,
      );
  }
  must(run, ['d1', 'migrations', 'apply', 'DB', '--remote'], 'applying remote migrations');
  out('Remote migrations: applied.');
  const admin = await seed(deps, { themes, locales });

  // 7. What the owner needs next; never a secret.
  const team = teamHost(config.vars.ACCESS_TEAM_DOMAIN) || '<your-team>.cloudflareaccess.com';
  out('');
  out('Class Hub setup is complete:');
  out(`  Account id:           ${accountId}`);
  out(`  Worker hostname:      ${await workersHostname(deps, slug)}`);
  out(`  D1 database:          ${dbName} (${databaseId})`);
  out(`  R2 bucket:            ${bucket}`);
  out(`  Bootstrap admin:      ${admin ?? 'none (members exist; setup adds nobody)'}`);
  out(`  Google redirect URI:  https://${team}/cdn-cgi/access/callback`);
  out('');
  out('Next: npm run deploy (the site stays locked), then docs/GOOGLE_ACCESS.md.');
  return 0;
}
