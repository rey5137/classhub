// R-OPS-10: `npm run preflight`, every item reported pass/fail with its fix.
// Cloudflare reads go through the injected runner (cf.mjs, INV-9); the network
// reads (JWKS, the no-cookie redirect, GitHub releases) through the injected
// fetch, each with a timeout. Unit tests break one item per fixture (AC-OPS-04).

import { spawnSync } from 'node:child_process';
import { backupGate, DESTRUCTIVE_MIGRATION } from './backup-gate.mjs';
import { apiGet, apiLookup, d1Remote, reason } from './cf-child.mjs';
import { SEAT_LIMIT, seatsUsedSql } from './invite.mjs';
import { compareMigrations, localMigrations } from './migrations.mjs';
import {
  ACCESS_VARS,
  hostOf,
  knownHostnames,
  readWorkerConfig,
  teamHost,
} from './worker-config.mjs';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * @typedef {'pass' | 'fail' | 'warn' | 'info'} Status
 * @typedef {{ id: string; status: Status; detail: string; fix?: string }} Check
 * @typedef {{
 *   run: import('./cf-child.mjs').CfRunner;
 *   fetch: typeof fetch;
 *   root: string;
 *   env: Record<string, string>;
 *   version: string;
 *   repo: string | null;
 *   now?: number;
 * }} PreflightDeps
 *   `repo` is `owner/name` on GitHub, for the release notice (R-OPS-13).
 */

/** @param {string} id @param {string} detail @returns {Check} */
const pass = (id, detail) => ({ id, status: 'pass', detail });
/** @param {string} id @param {string} detail @param {string} fix @returns {Check} */
const fail = (id, detail, fix) => ({ id, status: 'fail', detail, fix });

/** @param {typeof fetch} doFetch @param {string} url @param {RequestInit} [init] */
async function fetchWithTimeout(doFetch, url, init = {}) {
  return doFetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** @param {PreflightDeps} deps @returns {Promise<Check[]>} */
export async function runPreflight(deps) {
  const { run, env } = deps;
  const now = deps.now ?? Date.now();
  /** @type {Check[]} */
  const checks = [];
  const setupFix = 'run npm run setup (docs/DEPLOY_CLOUDFLARE.md, "Setup by hand" for each step).';

  // Account: the file, the env and what the token sees agree (R-PLAT-12/13).
  let config;
  try {
    config = readWorkerConfig(deps.root);
  } catch (error) {
    config = null;
    checks.push(fail('account', /** @type {Error} */ (error).message, setupFix));
  }
  if (!config && checks.length === 0) {
    checks.push(fail('account', 'wrangler.jsonc does not exist.', setupFix));
  }
  if (!config) return checks;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? '';
  if (!accountId || config.account_id !== accountId) {
    checks.push(
      fail(
        'account',
        `wrangler.jsonc names account ${config.account_id ?? '(none)'}, .env.cloudflare names ${accountId || '(none)'}.`,
        'make CLOUDFLARE_ACCOUNT_ID and wrangler.jsonc agree, then npm run setup.',
      ),
    );
    return checks;
  }
  const whoami = run(['whoami']);
  if (whoami.status !== 0) {
    checks.push(
      fail(
        'account',
        `the token cannot be used for account ${accountId}: ${reason(whoami)}`,
        'create an account-scoped API token for this account (.env.cloudflare.example lists its permissions).',
      ),
    );
    return checks;
  }
  checks.push(pass('account', `account ${accountId}; the token sees it and only it.`));

  // Bindings: declared in the config and present in the account.
  const db = (config.d1_databases ?? []).find(
    (/** @type {any} */ entry) => entry?.binding === 'DB',
  );
  const media = (config.r2_buckets ?? []).find(
    (/** @type {any} */ entry) => entry?.binding === 'MEDIA',
  );
  const room = (config.durable_objects?.bindings ?? []).find(
    (/** @type {any} */ entry) => entry?.name === 'CHAT_ROOM' && entry?.class_name === 'ChatRoom',
  );
  const sqliteRoom = (config.migrations ?? []).some((/** @type {any} */ tag) =>
    tag?.new_sqlite_classes?.includes('ChatRoom'),
  );
  const listed = run(['d1', 'list', '--json']);
  const databases = listed.status === 0 ? parseList(listed.stdout) : null;
  const bucketLookup = media?.bucket_name
    ? apiLookup(run, `/r2/buckets/${media.bucket_name}`)
    : null;
  // Fail closed: an unreadable answer is reported as such, never as "exists".
  const missing = [
    !db?.database_id && 'D1 binding DB in wrangler.jsonc',
    db?.database_id && !databases && `a readable D1 database list (${reason(listed)})`,
    db?.database_id &&
      databases &&
      !databases.some((/** @type {any} */ entry) => entry?.uuid === db.database_id) &&
      `D1 database ${db.database_name ?? db.database_id} in the account`,
    !media?.bucket_name && 'R2 binding MEDIA in wrangler.jsonc',
    bucketLookup &&
      !bucketLookup.found &&
      (bucketLookup.missing
        ? `R2 bucket ${media.bucket_name} in the account`
        : `a readable R2 bucket ${media.bucket_name} (${bucketLookup.reason})`),
    (!room || !sqliteRoom) && 'Durable Object CHAT_ROOM (SQLite ChatRoom) in wrangler.jsonc',
  ].filter(Boolean);
  checks.push(
    missing.length === 0
      ? pass(
          'bindings',
          `DB → ${db.database_name}, MEDIA → ${media.bucket_name}, CHAT_ROOM → ChatRoom.`,
        )
      : fail('bindings', `missing: ${missing.join('; ')}.`, setupFix),
  );

  // One D1 round trip for the database-side items.
  // R-OPS-10: any active admin passes; the bootstrap admin (R-AUTH-12) is required only
  // until the first unlock has been audited.
  const bootstrap = `select u.status from users u join invites i on i.email = u.auth_email and i.invited_by = u.id where u.role = 'admin' order by u.created_at limit 1`;
  const adminState = `select (select count(*) from users where role = 'admin' and status = 'active') as active, (select count(*) from audit_events where action = 'site.unlocked') as unlocked`;
  /** @type {Record<string, unknown>[][] | null} */
  let rows = null;
  let d1Error = '';
  try {
    rows = await d1Remote(run, [
      'select name from d1_migrations order by id',
      bootstrap,
      adminState,
      `select ${seatsUsedSql(now)} as used`,
      'select count(*) as n from backup_runs where verified_at is not null',
    ]);
  } catch (error) {
    d1Error = /** @type {Error} */ (error).message;
  }
  const unreadable = (/** @type {string} */ id) => fail(id, `cannot read D1: ${d1Error}`, setupFix);

  // Migrations: current, and none newer than this checkout (R-OPS-08). A pending
  // migration fails until it is applied, so a destructive one never slips past.
  if (rows) {
    // d1Remote returns exactly one result set per statement.
    const remote = rows[0].map((row) => String(row.name));
    const { pending, ahead } = compareMigrations(
      localMigrations(deps.root, db?.migrations_dir),
      remote,
    );
    checks.push(
      ahead.length > 0
        ? fail(
            'migrations',
            `the database has migrations this checkout lacks: ${ahead.join(', ')}.`,
            'git pull --ff-only to the release that added them.',
          )
        : pending.length > 0
          ? fail(
              'migrations',
              `pending: ${pending.join(', ')}.`,
              'npm run backup, then npm run db:migrate:remote (R-OPS-12).',
            )
          : pass('migrations', `${remote.length} applied, none pending.`),
    );
    // R-DB-11 / AC-DB-05: a pending destructive step also needs the INV-7 backup.
    const destructive = pending.filter((name) => DESTRUCTIVE_MIGRATION.test(name));
    if (destructive.length > 0) {
      const gate = await backupGate(run);
      checks.push(
        gate.ok
          ? pass('destructive-migration', `${destructive.join(', ')} may apply: ${gate.detail}`)
          : fail(
              'destructive-migration',
              `pending destructive migration ${destructive.join(', ')} needs a verified backup newer than the last deploy: ${gate.detail}`,
              `${gate.fix} Apply it only with npm run db:migrate:remote (INV-7).`,
            ),
      );
    }
  } else checks.push(unreadable('migrations'));

  // Access vars in the deployed config, the same as .env.cloudflare, and the JWKS (R-AUTH-03/05).
  const vars = config.vars ?? {};
  const unset = ACCESS_VARS.filter((name) => !String(vars[name] ?? '').trim());
  const stale = ACCESS_VARS.filter(
    (name) => env[name]?.trim() && env[name]?.trim() !== String(vars[name] ?? '').trim(),
  );
  const team = teamHost(vars.ACCESS_TEAM_DOMAIN);
  if (unset.length > 0 || stale.length > 0) {
    checks.push(
      fail(
        'access',
        unset.length > 0
          ? `not set in wrangler.jsonc: ${unset.join(', ')}.`
          : `wrangler.jsonc differs from .env.cloudflare: ${stale.join(', ')}.`,
        'copy the team domain and the application AUD into .env.cloudflare (docs/GOOGLE_ACCESS.md section 5), then npm run deploy.',
      ),
    );
  } else {
    const keys = await jwksKeys(deps.fetch, team);
    checks.push(
      keys > 0
        ? pass('access', `team ${team}; its JWKS lists ${keys} key(s).`)
        : fail(
            'access',
            `the team JWKS at https://${team}/cdn-cgi/access/certs did not load.`,
            'check ACCESS_TEAM_DOMAIN is your Zero Trust team domain (Zero Trust → Settings → Custom pages).',
          ),
    );
  }

  // R-AUTH-02: every hostname, without a cookie, is sent to the team's login.
  const subdomain = /** @type {{ subdomain?: string } | null} */ (apiGet(run, '/workers/subdomain'))
    ?.subdomain;
  const hosts = knownHostnames(config, subdomain ?? null);
  const unguarded = [];
  if (config.workers_dev !== false && !subdomain) unguarded.push('workers.dev (subdomain unknown)');
  for (const host of hosts) {
    let location = '';
    try {
      const response = await fetchWithTimeout(deps.fetch, `https://${host}/`, {
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        location = response.headers.get('location') ?? '';
      }
    } catch {
      location = '';
    }
    const target = hostOf(location);
    if (!team || target !== team) unguarded.push(host);
  }
  checks.push(
    unguarded.length === 0 && hosts.length > 0
      ? pass('hostnames', `${hosts.join(', ')} redirect to ${team} without a cookie.`)
      : fail(
          'hostnames',
          `not redirected to Access: ${unguarded.join(', ') || 'no hostname is known'}.`,
          'list each hostname in the one self-hosted Access application (docs/GOOGLE_ACCESS.md section 4).',
        ),
  );

  checks.push(
    config.preview_urls === false
      ? pass('preview', 'preview URLs are off.')
      : fail('preview', 'preview URLs are not off in wrangler.jsonc.', setupFix),
  );

  // The WebSocket probe is members-only and echo-only, but its sockets have no frame
  // cap and survive suspension, so it must not outlive the check (docs/DEPLOY_CLOUDFLARE.md).
  if (config.vars?.WS_PROBE) {
    checks.push({
      id: 'ws-probe',
      status: 'warn',
      detail: 'vars.WS_PROBE is set in wrangler.jsonc, so /__probe/ws is live.',
      fix: 'remove WS_PROBE from vars in wrangler.jsonc and npm run deploy again.',
    });
  }

  // AC-MEM-08: the bucket is reachable only through the Worker.
  const bucket = String(media?.bucket_name ?? '');
  const managed = /** @type {{ enabled?: boolean } | null} */ (
    bucket ? apiGet(run, `/r2/buckets/${bucket}/domains/managed`) : null
  );
  const custom = /** @type {{ domains?: unknown[] } | null} */ (
    bucket ? apiGet(run, `/r2/buckets/${bucket}/domains/custom`) : null
  );
  // Fail closed: an answer without the expected fields counts as unreadable.
  const exposures = [
    typeof managed?.enabled !== 'boolean' && 'r2.dev status unreadable',
    managed?.enabled === true && 'public r2.dev URL enabled',
    !Array.isArray(custom?.domains) && 'custom domains unreadable',
    Array.isArray(custom?.domains) && custom.domains.length > 0 && 'a custom domain is connected',
  ].filter(Boolean);
  checks.push(
    exposures.length === 0
      ? pass('bucket', `${bucket} has no r2.dev URL and no custom domain.`)
      : fail(
          'bucket',
          `${bucket || 'the bucket'}: ${exposures.join('; ')}.`,
          `R2 → ${bucket} → Settings: disable the r2.dev URL and remove custom domains (node scripts/cf.mjs r2 bucket dev-url disable ${bucket}).`,
        ),
  );

  if (rows) {
    const status = rows[1]?.[0]?.status;
    const activeAdmins = countOf(rows[2], 'active');
    const everUnlocked = (countOf(rows[2], 'unlocked') ?? 0) > 0;
    // Fail closed: an unreadable count never passes.
    if (activeAdmins === null) {
      checks.push(fail('admin', 'the admin count could not be read from D1.', setupFix));
    } else if (everUnlocked) {
      checks.push(
        activeAdmins > 0
          ? pass('admin', `${activeAdmins} active admin(s).`)
          : fail(
              'admin',
              'no admin is active.',
              'reactivate an admin in /admin, or add one (npm run invite -- add <email> --role admin) and have them sign in.',
            ),
      );
    } else {
      checks.push(
        status === 'active'
          ? pass('admin', 'the bootstrap admin has signed in and is active.')
          : fail(
              'admin',
              status ? `the bootstrap admin is ${status}.` : 'no bootstrap admin exists.',
              status === 'invited'
                ? 'sign in once with the bootstrap admin email (it opens /admin/setup), or rerun npm run setup to correct the email.'
                : setupFix,
            ),
      );
    }
    const used = countOf(rows[3], 'used');
    checks.push(
      used === null
        ? fail('seats', 'the seat count could not be read from D1.', setupFix)
        : used < SEAT_LIMIT
          ? pass('seats', `${used} of ${SEAT_LIMIT} Zero Trust seats used.`)
          : fail(
              'seats',
              `${used} seats used; the Zero Trust Free limit is ${SEAT_LIMIT}.`,
              'remove members or revoke invites (npm run invite -- remove <email>).',
            ),
    );
    const backups = countOf(rows[4], 'n');
    checks.push(
      backups === null
        ? fail('backup', 'the backup count could not be read from D1.', setupFix)
        : backups > 0
          ? pass('backup', `${backups} verified backup(s).`)
          : {
              id: 'backup',
              status: 'warn',
              detail: 'no backup yet; nothing can be restored if the database is lost.',
              fix: 'run npm run backup (docs/DEPLOY_CLOUDFLARE.md, "Backups").',
            },
    );
  } else checks.push(unreadable('admin'), unreadable('seats'), unreadable('backup'));

  checks.push(await releaseNotice(deps));
  return checks;
}

/**
 * A `count(*)` from a one-row result set, or null when it is absent or not a
 * non-negative integer (the caller fails closed).
 * @param {Record<string, unknown>[] | undefined} set @param {string} field
 */
function countOf(set, field) {
  const value = set?.length === 1 ? Number(set[0]?.[field]) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** @param {string} text @returns {unknown[] | null} null when it is not a JSON list */
function parseList(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The number of keys the team's JWKS lists; 0 when it does not load. */
async function jwksKeys(/** @type {typeof fetch} */ doFetch, /** @type {string} */ team) {
  try {
    const response = await fetchWithTimeout(doFetch, `https://${team}/cdn-cgi/access/certs`);
    const body = response.ok ? await response.json() : null;
    return Array.isArray(body?.keys) ? body.keys.length : 0;
  } catch {
    return 0;
  }
}

/** R-OPS-13: informational only; any failure to check is itself only a notice. */
async function releaseNotice(/** @type {PreflightDeps} */ deps) {
  /** @type {(detail: string) => Check} */
  const info = (detail) => ({ id: 'release', status: 'info', detail });
  if (!deps.repo) return info(`running ${deps.version}; no GitHub repository to compare with.`);
  try {
    const response = await fetchWithTimeout(
      deps.fetch,
      `https://api.github.com/repos/${deps.repo}/releases/latest`,
      { headers: { accept: 'application/vnd.github+json' } },
    );
    const body = response.ok ? await response.json() : null;
    const latest = String(body?.tag_name ?? '').replace(/^v/, '');
    if (!latest) return info(`running ${deps.version}; no published release found.`);
    return latest === deps.version
      ? info(`running ${deps.version}, the newest release.`)
      : info(`running ${deps.version}; release ${latest} exists: ${body.html_url ?? ''}`);
  } catch {
    return info(`running ${deps.version}; the release check could not reach GitHub.`);
  }
}

const LABEL = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };

/**
 * Prints every check and returns the exit code: nonzero on any failure.
 * @param {Check[]} checks @param {(line: string) => void} out
 */
export function report(checks, out) {
  for (const check of checks) {
    out(`${LABEL[check.status]}  ${check.id}: ${check.detail}`);
    if (check.fix && check.status !== 'pass') out(`      fix: ${check.fix}`);
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  out(
    `Preflight: ${failed === 0 ? 'passed' : `${failed} failed`}${warned ? `, ${warned} warning(s)` : ''}.`,
  );
  return failed === 0 ? 0 : 1;
}

/**
 * `owner/name` from the checkout's GitHub remote, or null (R-OPS-13 needs no more).
 * @param {string} root @returns {string | null}
 */
export function githubRepo(root) {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  });
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
    result.stdout?.trim() ?? '',
  );
  return match?.[1] ?? null;
}
