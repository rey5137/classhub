import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { report, runPreflight, type Check } from '../../scripts/lib/preflight.mjs';
import { runSetup } from '../../scripts/lib/setup.mjs';
import { runLock, runUnlock } from '../../scripts/lib/unlock.mjs';
import { ACCOUNT, createSandbox, type Sandbox } from '../fixtures/script-sandbox';

// AC-OPS-04: a deployment that passes every R-OPS-10 item, then one fixture per
// broken item, each failing preflight for that item's reason and no other.

const TEAM = 'myteam.cloudflareaccess.com';
const HOST = 'classhub.fake-sub.workers.dev';
const ADMIN = 'admin@example.test';

let box: Sandbox;
let env: Record<string, string>;
/** URL → response; anything else is a network error. */
let web: Map<string, () => Response>;
let fetched: string[];
type CfResult = { status: number; stdout: string; stderr: string };
/** Rewrites what the fakes answer, for the malformed-answer fixtures. */
let tamper: ((args: string[], result: CfResult) => CfResult) | null;
const run = (args: string[], options?: { input?: string }) => {
  const result = box.runner(args, options);
  return tamper ? tamper(args, result) : result;
};

/** The d1 execute batch whose SQL mentions `marker`, with result set `index` changed. */
function tamperD1(marker: string, change: (sets: unknown[]) => unknown[]) {
  tamper = (args, result) => {
    if (args[1] !== 'execute' || !String(args.at(-1)).includes(marker)) return result;
    return { ...result, stdout: JSON.stringify(change(JSON.parse(result.stdout) as unknown[])) };
  };
}

function tamperApi(path: string, result: unknown) {
  tamper = (args, original) =>
    args[0] === 'api' && args[1] === path
      ? { status: 0, stdout: JSON.stringify(result), stderr: '' }
      : original;
}

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  fetched.push(`${url} ${init?.redirect ?? 'follow'} ${init?.signal ? 'timeout' : 'no-timeout'}`);
  const answer = web.get(url);
  return answer ? Promise.resolve(answer()) : Promise.reject(new TypeError('fetch failed'));
}

const accessRedirect = () =>
  new Response(null, {
    status: 302,
    headers: { location: `https://${TEAM}/cdn-cgi/access/login/${HOST}?kid=x` },
  });

function config(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(box.dir, 'wrangler.jsonc'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function writeConfig(next: Record<string, unknown>) {
  writeFileSync(join(box.dir, 'wrangler.jsonc'), JSON.stringify(next));
}

function sql(statement: string) {
  const db = box.d1();
  db.prepare(statement).run();
  db.close();
}

const preflight = () =>
  runPreflight({
    run,
    fetch: fakeFetch as typeof fetch,
    root: box.dir,
    env,
    version: '0.1.0',
    repo: 'example/classhub',
    now: Date.now(),
  });

const failing = (checks: Check[]) =>
  checks.filter((check) => check.status === 'fail').map((check) => check.id);

beforeEach(async () => {
  box = await createSandbox();
  fetched = [];
  tamper = null;
  // A real setup run, in process, then what the owner does after it.
  await runSetup({
    run: box.runner,
    ask: async ({ key, fallback }) => (key === 'admin' ? ADMIN : fallback),
    out: () => {},
    root: box.dir,
    nodeVersion: '24.0.0',
    uuid: () => crypto.randomUUID(),
    secret: () => 'secret-value',
  });
  env = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: 'unused',
    ACCESS_TEAM_DOMAIN: 'myteam',
    ACCESS_AUD: 'aud-1',
  };
  const current = config();
  writeConfig({ ...current, vars: { ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: 'aud-1' } });
  sql(`update users set status = 'active' where auth_email = '${ADMIN}'`);
  // As the first verified sign-in leaves it (R-AUTH-08).
  sql(`update invites set status = 'accepted' where email = '${ADMIN}'`);
  web = new Map([
    [`https://${TEAM}/cdn-cgi/access/certs`, () => Response.json({ keys: [{ kid: 'k1' }] })],
    [`https://${HOST}/`, accessRedirect],
    [
      'https://api.github.com/repos/example/classhub/releases/latest',
      () => Response.json({ tag_name: 'v0.1.0', html_url: 'https://github.example.test/r' }),
    ],
  ]);
});

afterEach(() => box.close());

describe('preflight (R-OPS-10)', () => {
  it('passes a healthy deployment, warning only that no backup exists yet', async () => {
    const checks = await preflight();
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['account', 'pass'],
      ['bindings', 'pass'],
      ['migrations', 'pass'],
      ['access', 'pass'],
      ['hostnames', 'pass'],
      ['preview', 'pass'],
      ['bucket', 'pass'],
      ['admin', 'pass'],
      ['seats', 'pass'],
      ['backup', 'warn'],
      ['release', 'info'],
    ]);
    const lines: string[] = [];
    expect(report(checks, (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toBe('Preflight: passed, 1 warning(s).');
    // Every network read is bounded, and the probe of the hostname never follows the redirect.
    expect(fetched.every((line) => line.endsWith(' timeout'))).toBe(true);
    expect(fetched).toContain(`https://${HOST}/ manual timeout`);
  });

  it('finds the bucket by name even when it is past the first page of the account list', async () => {
    const others = Array.from({ length: 24 }, (_, index) => `a-${String(index).padStart(2, '0')}`);
    box.writeState({ ...box.readState(), buckets: [...others, 'classhub-media'] });
    expect(failing(await preflight())).toEqual([]);
  });

  it('a verified backup clears the warning', async () => {
    sql(
      `insert into backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) values ('b1', 'full', 'x', 0, 0, 1)`,
    );
    expect((await preflight()).find((check) => check.id === 'backup')?.status).toBe('pass');
  });

  it('R-OPS-13 a newer release, or GitHub unreachable, is a notice and never a failure', async () => {
    web.set('https://api.github.com/repos/example/classhub/releases/latest', () =>
      Response.json({ tag_name: 'v0.2.0', html_url: 'https://github.example.test/r' }),
    );
    let checks = await preflight();
    expect(checks.at(-1)).toMatchObject({ id: 'release', status: 'info' });
    expect(checks.at(-1)?.detail).toContain('release 0.2.0 exists');
    expect(failing(checks)).toEqual([]);

    web.delete('https://api.github.com/repos/example/classhub/releases/latest');
    checks = await preflight();
    expect(checks.at(-1)?.detail).toContain('could not reach GitHub');
    expect(failing(checks)).toEqual([]);
  });

  const fixtures: { name: string; fails: string[]; reason: string; breakIt: () => void }[] = [
    {
      name: 'wrangler.jsonc names another account',
      fails: ['account'],
      reason: 'names account',
      breakIt: () => writeConfig({ ...config(), account_id: '4'.repeat(32) }),
    },
    {
      name: 'wrangler.jsonc is missing',
      fails: ['account'],
      reason: 'does not exist',
      breakIt: () => rmSync(join(box.dir, 'wrangler.jsonc')),
    },
    {
      name: 'the token cannot see the account',
      fails: ['account'],
      reason: 'the token cannot be used',
      breakIt: () => box.writeState({ ...box.readState(), failures: { whoami: 'Unauthorized' } }),
    },
    {
      // Nothing database-side can be read either, and each says so.
      name: 'the configured D1 database does not exist',
      fails: ['bindings', 'migrations', 'admin', 'seats', 'backup'],
      reason: 'D1 database classhub-db in the account',
      breakIt: () => {
        const current = config();
        const [db] = current.d1_databases as Record<string, string>[];
        writeConfig({ ...current, d1_databases: [{ ...db, database_id: 'missing-uuid' }] });
      },
    },
    {
      name: 'the R2 bucket does not exist',
      fails: ['bindings', 'bucket'],
      reason: 'R2 bucket classhub-media in the account',
      breakIt: () => box.writeState({ ...box.readState(), buckets: [] }),
    },
    {
      name: 'the Durable Object binding is missing',
      fails: ['bindings'],
      reason: 'CHAT_ROOM',
      breakIt: () => writeConfig({ ...config(), durable_objects: { bindings: [] } }),
    },
    {
      name: 'a migration is pending',
      fails: ['migrations'],
      reason: 'pending: 0001_init.sql',
      breakIt: () => sql(`delete from d1_migrations`),
    },
    {
      name: 'the database is ahead of the checkout',
      fails: ['migrations'],
      reason: 'lacks: 0002_future.sql',
      breakIt: () => sql(`insert into d1_migrations (name) values ('0002_future.sql')`),
    },
    {
      name: 'ACCESS_AUD is not set',
      fails: ['access'],
      reason: 'not set in wrangler.jsonc: ACCESS_AUD',
      breakIt: () =>
        writeConfig({ ...config(), vars: { ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: '' } }),
    },
    {
      name: '.env.cloudflare has an AUD not yet deployed',
      fails: ['access'],
      reason: 'differs from .env.cloudflare: ACCESS_AUD',
      breakIt: () => (env.ACCESS_AUD = 'aud-2'),
    },
    {
      name: 'the team JWKS does not load',
      fails: ['access'],
      reason: 'did not load',
      breakIt: () =>
        web.set(`https://${TEAM}/cdn-cgi/access/certs`, () => new Response('no', { status: 404 })),
    },
    {
      name: 'the workers.dev hostname answers without Access',
      fails: ['hostnames'],
      reason: `not redirected to Access: ${HOST}`,
      breakIt: () => web.set(`https://${HOST}/`, () => new Response('<html>', { status: 200 })),
    },
    {
      name: 'a custom domain redirects somewhere other than the team',
      fails: ['hostnames'],
      reason: 'not redirected to Access: class.example.test',
      breakIt: () => {
        writeConfig({
          ...config(),
          routes: [{ pattern: 'class.example.test', custom_domain: true }],
        });
        web.set(
          'https://class.example.test/',
          () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://other.cloudflareaccess.com/x' },
            }),
        );
      },
    },
    {
      name: 'preview URLs are on',
      fails: ['preview'],
      reason: 'preview URLs are not off',
      breakIt: () => writeConfig({ ...config(), preview_urls: true }),
    },
    {
      name: 'the bucket has a public r2.dev URL (AC-MEM-08)',
      fails: ['bucket'],
      reason: 'public r2.dev URL enabled',
      breakIt: () => box.writeState({ ...box.readState(), devUrl: { 'classhub-media': true } }),
    },
    {
      name: 'the bucket has a custom domain (AC-MEM-08)',
      fails: ['bucket'],
      reason: 'a custom domain is connected',
      breakIt: () =>
        box.writeState({
          ...box.readState(),
          customDomains: { 'classhub-media': ['media.example.test'] },
        }),
    },
    {
      name: 'the bootstrap admin has not signed in',
      fails: ['admin'],
      reason: 'the bootstrap admin is invited',
      breakIt: () => sql(`update users set status = 'invited'`),
    },
    {
      name: 'all 50 seats are used',
      fails: ['seats'],
      reason: '50 seats used',
      breakIt: () => {
        const db = box.d1();
        const insert = db.prepare(
          `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values (?, ?, 'M', 'm', 'member', 'active', 1, 1)`,
        );
        for (let index = 0; index < 49; index += 1)
          insert.run(`m${index}`, `m${index}@example.test`);
        db.close();
      },
    },
    {
      name: 'the D1 database list cannot be read',
      fails: ['bindings'],
      reason: 'a readable D1 database list',
      breakIt: () =>
        box.writeState({ ...box.readState(), failures: { 'd1 list': 'Authentication error' } }),
    },
    {
      name: 'the bucket lookup fails for a reason other than 404',
      fails: ['bindings'],
      reason: 'a readable R2 bucket classhub-media',
      breakIt: () =>
        box.writeState({ ...box.readState(), failures: { 'api bucket': 'forbidden' } }),
    },
    {
      name: 'the seat count comes back empty',
      fails: ['seats'],
      reason: 'the seat count could not be read',
      breakIt: () =>
        tamperD1('backup_runs', (sets) =>
          sets.map((set, at) => (at === 3 ? { results: [] } : set)),
        ),
    },
    {
      name: 'the seat count is not a number',
      fails: ['seats'],
      reason: 'the seat count could not be read',
      breakIt: () =>
        tamperD1('backup_runs', (sets) =>
          sets.map((set, at) => (at === 3 ? { results: [{ used: 'many' }] } : set)),
        ),
    },
    {
      name: 'the backup count comes back empty',
      fails: ['backup'],
      reason: 'the backup count could not be read',
      breakIt: () =>
        tamperD1('backup_runs', (sets) =>
          sets.map((set, at) => (at === 4 ? { results: [] } : set)),
        ),
    },
    {
      name: 'the bootstrap admin lookup comes back empty',
      fails: ['admin'],
      reason: 'no bootstrap admin exists',
      breakIt: () =>
        tamperD1('backup_runs', (sets) =>
          sets.map((set, at) => (at === 1 ? { results: [] } : set)),
        ),
    },
    {
      name: 'D1 answers fewer result sets than statements',
      fails: ['migrations', 'admin', 'seats', 'backup'],
      reason: 'unexpected result shape',
      breakIt: () => tamperD1('backup_runs', (sets) => sets.slice(0, 2)),
    },
    {
      name: 'a result set has no results array',
      fails: ['migrations', 'admin', 'seats', 'backup'],
      reason: 'unexpected result shape',
      breakIt: () =>
        tamperD1('backup_runs', (sets) =>
          sets.map((set, at) => (at === 0 ? { success: true } : set)),
        ),
    },
    {
      name: 'the r2.dev status lacks its enabled flag',
      fails: ['bucket'],
      reason: 'r2.dev status unreadable',
      breakIt: () =>
        tamperApi('/r2/buckets/classhub-media/domains/managed', { domain: 'x.r2.dev' }),
    },
    {
      name: 'the custom domain answer is not a list',
      fails: ['bucket'],
      reason: 'custom domains unreadable',
      breakIt: () => tamperApi('/r2/buckets/classhub-media/domains/custom', { domains: 'none' }),
    },
  ];

  it.each(fixtures)('AC-OPS-04 fails when $name', async ({ fails, reason, breakIt }) => {
    breakIt();
    const checks = await preflight();
    expect(failing(checks)).toEqual(fails);
    const broken = checks.find((check) => check.id === fails[0]);
    expect(broken?.detail).toContain(reason);
    expect(broken?.fix).toBeTruthy();
    expect(report(checks, () => {})).toBe(1);
  });
});

describe('preflight admin rule and probe (R-OPS-10, R-AUTH-12)', () => {
  const secondAdmin = () =>
    sql(
      `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values ('a2', 'a2@example.test', 'A', 'a', 'admin', 'active', 1, 1)`,
    );
  const markUnlocked = () =>
    sql(
      `insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) values ('u1', null, 'site.unlocked', 'site_settings', 'setup_state', 1)`,
    );
  const admin = async () => (await preflight()).find((check) => check.id === 'admin');

  it('R-OPS-10 before the first unlock only the bootstrap admin counts, however many others are active', async () => {
    secondAdmin();
    sql(`update users set status = 'suspended' where auth_email = '${ADMIN}'`);
    expect(await admin()).toMatchObject({ status: 'fail' });
    sql(`update users set status = 'invited' where auth_email = '${ADMIN}'`);
    expect(await admin()).toMatchObject({ status: 'fail' });
  });

  it('R-OPS-10 after an unlock any active admin passes, even when the bootstrap admin is gone', async () => {
    markUnlocked();
    secondAdmin();
    sql(`update users set status = 'suspended' where auth_email = '${ADMIN}'`);
    expect(await admin()).toMatchObject({ status: 'pass', detail: '1 active admin(s).' });
    sql(`update users set role = 'member' where auth_email = '${ADMIN}'`);
    expect(await admin()).toMatchObject({ status: 'pass' });
  });

  it('R-OPS-10 after an unlock with no active admin it fails closed', async () => {
    markUnlocked();
    sql(`update users set status = 'suspended'`);
    const check = await admin();
    expect(check).toMatchObject({ status: 'fail', detail: 'no admin is active.' });
    expect(check?.fix).toBeTruthy();
  });

  it('R-OPS-10 an unreadable admin or unlock count never passes', async () => {
    markUnlocked();
    secondAdmin();
    sql(`update users set status = 'suspended' where auth_email = '${ADMIN}'`);
    tamperD1('backup_runs', (sets) =>
      sets.map((set, at) => (at === 2 ? { results: [{ active: 'x', unlocked: 1 }] } : set)),
    );
    expect(await admin()).toMatchObject({ status: 'fail' });
    // An unreadable unlock count falls back to the stricter bootstrap rule.
    tamperD1('backup_runs', (sets) =>
      sets.map((set, at) => (at === 2 ? { results: [{ active: 1, unlocked: 'x' }] } : set)),
    );
    expect(await admin()).toMatchObject({
      status: 'fail',
      detail: 'the bootstrap admin is suspended.',
    });
  });

  describe('AC-DB-05 a pending destructive migration', () => {
    const deployedAt = Date.parse('2026-11-01T00:00:00.000Z');
    const pendingDestructive = () =>
      writeFileSync(join(box.dir, 'migrations', '0099_drop_x_destructive.sql'), 'select 1;\n');
    const deployed = () =>
      box.writeState({
        ...box.readState(),
        deployments: [{ id: 'd1', created_on: new Date(deployedAt).toISOString() }],
      });
    const backupAt = (at: number) =>
      sql(
        `insert into backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) values ('b${at}', 'full', 'x', 0, 0, ${at})`,
      );
    const destructive = async () => {
      const checks = await preflight();
      return {
        failing: failing(checks),
        check: checks.find((c) => c.id === 'destructive-migration'),
      };
    };

    it('AC-DB-05 refuses without any verified backup, with its own message', async () => {
      pendingDestructive();
      deployed();
      const { failing: ids, check } = await destructive();
      expect(ids).toEqual(['migrations', 'destructive-migration']);
      expect(check?.detail).toBe(
        'pending destructive migration 0099_drop_x_destructive.sql needs a verified backup newer than the last deploy: no verified backup exists.',
      );
      expect(check?.fix).toContain('npm run db:migrate:remote');
    });

    it('AC-DB-05 refuses when the newest verified backup is older than the last deploy', async () => {
      pendingDestructive();
      deployed();
      backupAt(deployedAt - 1);
      const { check } = await destructive();
      expect(check).toMatchObject({ status: 'fail' });
      expect(check?.detail).toContain(
        'is not newer than the last deploy (2026-11-01T00:00:00.000Z)',
      );
    });

    it('AC-DB-05 refuses when the last deploy time cannot be read', async () => {
      pendingDestructive();
      backupAt(deployedAt + 1);
      box.writeState({ ...box.readState(), failures: { 'deployments list': 'auth error' } });
      const { check } = await destructive();
      expect(check).toMatchObject({ status: 'fail' });
      expect(check?.detail).toContain('cannot read the last deploy time');
    });

    it('AC-DB-05 a newer verified backup clears the destructive item (the pending one still fails)', async () => {
      pendingDestructive();
      deployed();
      backupAt(deployedAt + 1);
      const { failing: ids, check } = await destructive();
      expect(ids).toEqual(['migrations']);
      expect(check).toMatchObject({ status: 'pass' });
    });

    it('AC-DB-05 is not checked when no destructive migration is pending', async () => {
      expect((await destructive()).check).toBeUndefined();
    });
  });
});

describe('unlock and lock (R-OPS-11)', () => {
  const state = () => {
    const db = box.d1();
    const value = db
      .prepare(`select value_json from site_settings where key = 'setup_state'`)
      .pluck()
      .get();
    const audit = db
      .prepare('select action from audit_events where actor_id is null')
      .pluck()
      .all();
    db.close();
    return { value, audit };
  };
  const unlock = (lines: string[]) =>
    runUnlock({
      run: box.runner,
      fetch: fakeFetch as typeof fetch,
      root: box.dir,
      env,
      version: '0.1.0',
      repo: null,
      out: (line) => lines.push(line),
      uuid: () => crypto.randomUUID(),
    });

  it('AC-OPS-05 unlock refuses while preflight fails and leaves the site locked', async () => {
    web.set(`https://${HOST}/`, () => new Response('<html>', { status: 200 }));
    const lines: string[] = [];

    expect(await unlock(lines)).toBe(1);
    expect(lines).toContain('Unlock refused: the site stays locked until every check passes.');
    expect(state()).toEqual({ value: '"locked"', audit: [] });
  });

  it('AC-OPS-05 unlock opens the site once preflight passes, and recommends a second admin (R-AUTH-14)', async () => {
    const lines: string[] = [];

    expect(await unlock(lines)).toBe(0);
    expect(state()).toEqual({ value: '"unlocked"', audit: ['site.unlocked'] });
    expect(lines.at(-1)).toContain('add a second admin');

    // With a second active admin there is nothing to recommend.
    sql(
      `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values ('a2', 'a2@example.test', 'A', 'a', 'admin', 'active', 1, 1)`,
    );
    const again: string[] = [];
    expect(await unlock(again)).toBe(0);
    expect(again.join('\n')).not.toContain('second admin');
  });

  it('R-OPS-10 lock then unlock works after the bootstrap admin was demoted, with another admin active', async () => {
    expect(await unlock([])).toBe(0);
    await runLock({ run: box.runner, out: () => {}, uuid: () => crypto.randomUUID() });
    sql(
      `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values ('a2', 'a2@example.test', 'A', 'a', 'admin', 'active', 1, 1)`,
    );
    sql(`update users set role = 'member' where auth_email = '${ADMIN}'`);
    expect(await unlock([])).toBe(0);
    expect(state().value).toBe('"unlocked"');
  });

  it('AC-OPS-05 a runner that throws (on whoami) rejects unlock and leaves the site locked, unaudited', async () => {
    const throwing = (args: string[], options?: { input?: string }) => {
      if (args[0] === 'whoami') throw new Error('cannot run cf.mjs: spawn failed');
      return box.runner(args, options);
    };
    const lines: string[] = [];
    await expect(
      runUnlock({
        run: throwing,
        fetch: fakeFetch as typeof fetch,
        root: box.dir,
        env,
        version: '0.1.0',
        repo: null,
        out: (line) => lines.push(line),
        uuid: () => crypto.randomUUID(),
      }),
    ).rejects.toThrow('spawn failed');
    expect(state()).toEqual({ value: '"locked"', audit: [] });
    expect(lines.join('\n')).not.toContain('Unlocked');
  });

  it('AC-OPS-05 lock locks immediately, without running preflight', async () => {
    await unlock([]);
    const before = box.readState().calls.length;
    const lines: string[] = [];

    expect(
      await runLock({ run: box.runner, out: (line) => lines.push(line), uuid: () => 'l1' }),
    ).toBe(0);
    expect(state()).toEqual({ value: '"locked"', audit: ['site.unlocked', 'site.locked'] });
    // One D1 batch: no whoami, no listing, no network.
    expect(
      box
        .readState()
        .calls.slice(before)
        .map((call) => call.slice(0, 2).join(' ')),
    ).toEqual(['d1 execute']);
  });
});
