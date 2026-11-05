import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEAT_LIMIT as APP_SEAT_LIMIT,
  SEAT_WARNING as APP_SEAT_WARNING,
} from '../../src/lib/server/services/members';
import type { CfRunner } from '../../scripts/lib/cf-child.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAccessPolicy,
  parseArgs,
  runInvite,
  SEAT_LIMIT,
  seatsUsedSql,
} from '../../scripts/lib/invite.mjs';

// AC-AUTH-11: `npm run invite` against SQLite standing in for D1 and a fake Access
// API standing in for Cloudflare; no network and no real account.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const ADMIN = { id: '01900000-0000-7000-8000-0000000000f1', email: 'boot.admin@example.test' };
const ACCOUNT = '11111111111111111111111111111111';
const TOKEN = 'fake-token-for-tests';

let sqlite: Database.Database;
let output: string[];
let counter: number;

function d1(statements: string[]) {
  const run = sqlite.transaction(() =>
    statements.map((statement) => {
      const prepared = sqlite.prepare(statement);
      return prepared.reader ? (prepared.all() as Record<string, unknown>[]) : (prepared.run(), []);
    }),
  );
  return Promise.resolve(run());
}

interface FakeApi {
  run: CfRunner;
  policy: {
    include: unknown[];
    require: unknown[];
    exclude: unknown[];
    name: string;
    decision: string;
  };
  requests: { method: string; path: string; body?: unknown }[];
  status: number;
}

function fakeAccess(emails: string[] = []): FakeApi {
  const api: FakeApi = {
    policy: {
      name: 'Class list',
      decision: 'allow',
      include: [{ group: { id: 'kept-group' } }, ...emails.map((email) => ({ email: { email } }))],
      // R-AUTH-15: the login methods live outside the include rule and stay as they are.
      require: [{ login_method: { id: 'google' } }, { login_method: { id: 'otp' } }],
      exclude: [],
    },
    requests: [],
    status: 200,
    // The `cf.mjs api` contract: `api <path>` is a GET, `api --put <path>` takes the body on stdin.
    run: (args, options = {}) => {
      const put = args[1] === '--put';
      const body = put ? JSON.parse(options.input ?? '{}') : undefined;
      api.requests.push({
        method: put ? 'PUT' : 'GET',
        path: args[put ? 2 : 1] ?? '',
        ...(body ? { body } : {}),
      });
      if (api.status !== 200) {
        return { status: 1, stdout: '', stderr: `cf.mjs: failed: HTTP ${api.status}` };
      }
      if (put) api.policy = { ...api.policy, ...body };
      return { status: 0, stdout: JSON.stringify(api.policy), stderr: '' };
    },
  };
  return api;
}

function policyEmails(api: FakeApi) {
  return api.policy.include
    .map((rule) => (rule as { email?: { email: string } }).email?.email)
    .filter(Boolean);
}

function deps(api: FakeApi | null) {
  return {
    d1,
    out: (line: string) => output.push(line),
    uuid: () => `01900000-0000-7000-8000-${String(++counter).padStart(12, '0')}`,
    expiryDays: 30 as number | null,
    access: api ? createAccessPolicy({ run: api.run, policyId: 'pol-1', appId: 'app-1' }) : null,
  };
}

const row = (sql: string) => sqlite.prepare(sql).get() as Record<string, unknown> | undefined;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(repoRoot, 'migrations', '0001_init.sql'), 'utf8'));
  const now = Date.now();
  sqlite
    .prepare(
      `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values (?, ?, 'Boot Admin', 'boot admin', 'admin', 'active', ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, now, now);
  sqlite
    .prepare(
      `insert into invites (id, email, invited_by, role, status, created_at) values ('inv-boot', ?, ?, 'admin', 'accepted', ?)`,
    )
    .run(ADMIN.email, ADMIN.id, now);
  output = [];
  counter = 0;
});

afterEach(() => sqlite.close());

describe('invite add/remove (R-AUTH-18)', () => {
  it('AC-AUTH-11 add with an Access-scoped token invites in D1 and adds the email to the policy', async () => {
    const api = fakeAccess([ADMIN.email]);
    const code = await runInvite(
      ['add', 'New.Friend@Example.test', '--name', 'New Friend'],
      deps(api),
    );
    expect(code).toBe(0);
    expect(
      row(
        `select status, role, invited_by, access_synced_at from invites where email = 'new.friend@example.test'`,
      ),
    ).toMatchObject({
      status: 'pending',
      role: 'member',
      invited_by: ADMIN.id,
    });
    expect(
      row(`select access_synced_at from invites where email = 'new.friend@example.test'`)
        ?.access_synced_at,
    ).not.toBeNull();
    expect(
      row(`select status, display_name from users where auth_email = 'new.friend@example.test'`),
    ).toEqual({
      status: 'invited',
      display_name: 'New Friend',
    });
    expect(policyEmails(api)).toEqual([ADMIN.email, 'new.friend@example.test']);
    // Other include rules and the login-method rules survive the update.
    expect(api.policy.include[0]).toEqual({ group: { id: 'kept-group' } });
    expect(api.policy.require).toEqual([
      { login_method: { id: 'google' } },
      { login_method: { id: 'otp' } },
    ]);
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /access/apps/app-1/policies/pol-1',
      'GET /access/apps/app-1/policies/pol-1',
      'PUT /access/apps/app-1/policies/pol-1',
    ]);
    expect(output.join('\n')).not.toContain(TOKEN);
  });

  it('R-PROF-08 stores the accent-folded name the directory searches', async () => {
    expect(await runInvite(['add', 'duc@example.test', '--name', 'Đặng Đức'], deps(null))).toBe(0);
    expect(
      row(`select display_name_norm from users where auth_email = 'duc@example.test'`),
    ).toEqual({ display_name_norm: 'dang duc' });
  });

  it('AC-AUTH-11 a repeated add changes nothing and does not rewrite the policy', async () => {
    const api = fakeAccess();
    await runInvite(['add', 'twice@example.test'], deps(api));
    const puts = api.requests.filter((request) => request.method === 'PUT').length;
    expect(await runInvite(['add', 'twice@example.test'], deps(api))).toBe(0);
    expect(row(`select count(*) as n from invites where email = 'twice@example.test'`)).toEqual({
      n: 1,
    });
    expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(puts);
    expect(output).toContain('twice@example.test already has a pending invite.');
    // Without --name, the local part stands in for the display name.
    expect(row(`select display_name from users where auth_email = 'twice@example.test'`)).toEqual({
      display_name: 'twice',
    });
  });

  it('AC-AUTH-11 remove with an Access-scoped token revokes in D1 first, then drops the email from the policy', async () => {
    const api = fakeAccess(['leaving@example.test']);
    await runInvite(['add', 'leaving@example.test'], deps(api));
    expect(await runInvite(['remove', 'leaving@example.test'], deps(api))).toBe(0);
    expect(row(`select status from invites where email = 'leaving@example.test'`)).toEqual({
      status: 'revoked',
    });
    expect(row(`select id from users where auth_email = 'leaving@example.test'`)).toBeUndefined();
    expect(policyEmails(api)).toEqual([]);
  });

  it('AC-AUTH-11 without an Access-scoped token prints the dashboard step and still changes the app list', async () => {
    expect(await runInvite(['add', 'manual@example.test'], deps(null))).toBe(0);
    expect(row(`select status from invites where email = 'manual@example.test'`)).toEqual({
      status: 'pending',
    });
    expect(output.join('\n')).toMatch(
      /Zero Trust → Access → Applications[\s\S]*add manual@example.test/,
    );

    // A token without the Access scope answers 403: same step, success, nothing marked synced.
    const api = fakeAccess();
    api.status = 403;
    output = [];
    expect(await runInvite(['add', 'scoped@example.test'], deps(api))).toBe(0);
    expect(output.join('\n')).toContain('add scoped@example.test');
    expect(row(`select access_synced_at from invites where email = 'scoped@example.test'`)).toEqual(
      { access_synced_at: null },
    );
  });

  it('fails, after printing the step, when the Access API errors', async () => {
    const api = fakeAccess();
    api.status = 500;
    expect(await runInvite(['add', 'flaky@example.test'], deps(api))).toBe(1);
    expect(output.join('\n')).toContain('add flaky@example.test');
  });

  it('R-AUTH-09 remove suspends an active member and keeps the row and profile, even with no sub', async () => {
    const now = Date.now();
    sqlite
      .prepare(
        `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values ('member-1', 'ann@example.test', 'Ann', 'ann', 'member', 'active', ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `insert into invites (id, email, invited_by, status, created_at) values ('inv-ann', 'ann@example.test', ?, 'accepted', ?)`,
      )
      .run(ADMIN.id, now);
    sqlite
      .prepare(
        `insert into profile_contacts (user_id, city, updated_at) values ('member-1', 'Hue', 0)`,
      )
      .run();
    expect(await runInvite(['remove', 'ann@example.test'], deps(null))).toBe(0);
    expect(row(`select status from users where id = 'member-1'`)).toEqual({ status: 'suspended' });
    expect(row(`select city from profile_contacts where user_id = 'member-1'`)).toEqual({
      city: 'Hue',
    });
    expect(row(`select status from invites where id = 'inv-ann'`)).toEqual({ status: 'accepted' });
  });

  it('R-AUTH-19 two concurrent adds cannot both take the last seat', async () => {
    const insert = sqlite.prepare(
      `insert into invites (id, email, invited_by, status, created_at) values (?, ?, ?, 'pending', 0)`,
    );
    for (let index = 1; index < SEAT_LIMIT - 1; index += 1) {
      insert.run(`seat-${index}`, `seat${index}@example.test`, ADMIN.id);
    }
    const codes = await Promise.all([
      runInvite(['add', 'race.one@example.test'], deps(null)),
      runInvite(['add', 'race.two@example.test'], deps(null)),
    ]);
    expect(codes.sort()).toEqual([0, 1]);
    expect(
      row(`select count(*) as n from invites where email like 'race.%' and status = 'pending'`),
    ).toEqual({ n: 1 });
    expect(row(`select count(*) as n from users where auth_email like 'race.%'`)).toEqual({ n: 1 });
  });

  it('R-AUTH-08 follows invite.expiryDays, including null for never', async () => {
    await runInvite(['add', 'forever@example.test'], { ...deps(null), expiryDays: null });
    expect(row(`select expires_at from invites where email = 'forever@example.test'`)).toEqual({
      expires_at: null,
    });
    await runInvite(['add', 'week@example.test'], { ...deps(null), expiryDays: 7, now: 1_000 });
    expect(row(`select expires_at from invites where email = 'week@example.test'`)).toEqual({
      expires_at: 1_000 + 7 * 86_400_000,
    });
  });

  it('suspends a member on remove but never the last active admin (R-NAV-06)', async () => {
    expect(await runInvite(['remove', ADMIN.email], deps(null))).toBe(1);
    expect(row(`select status from users where id = '${ADMIN.id}'`)).toEqual({ status: 'active' });
  });

  it('refuses past the seat limit (R-AUTH-19)', async () => {
    const insert = sqlite.prepare(
      `insert into invites (id, email, invited_by, status, created_at) values (?, ?, ?, 'pending', 0)`,
    );
    for (let index = 1; index < SEAT_LIMIT; index += 1)
      insert.run(`seat-${index}`, `seat${index}@example.test`, ADMIN.id);
    expect(await runInvite(['add', 'one.more@example.test'], deps(null))).toBe(1);
    expect(row(`select id from invites where email = 'one.more@example.test'`)).toBeUndefined();
  });

  it('R-AUTH-10 list shows where each email is: app, Access policy or both', async () => {
    const api = fakeAccess([ADMIN.email, 'stray@example.test']);
    await runInvite(['add', 'listed@example.test'], deps(null));
    output = [];
    expect(await runInvite(['list'], deps(api))).toBe(0);
    expect(output).toEqual([
      `${ADMIN.email}\taccepted\tadmin\tapp + access`,
      'listed@example.test\tpending\tmember\tapp only',
      'stray@example.test\t-\t-\taccess only',
    ]);
  });

  it('refuses an argument that is not one email address', () => {
    expect(() => parseArgs(['add', "x'@example.test"])).toThrow(/not an email/);
    expect(() => parseArgs(['add', 'a@example.test', 'b@example.test'])).toThrow(/usage/);
    expect(() => parseArgs(['add', 'a@example.test', '--role', 'owner'])).toThrow(/role/);
    expect(() => parseArgs(['purge'])).toThrow(/usage/);
  });
});

describe('invite parity with the app (gate fixes)', () => {
  const addMember = (id: string, email: string, role: string, status: string) => {
    const now = Date.now();
    sqlite
      .prepare(
        `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, email, id, id, role, status, now, now);
    sqlite
      .prepare(
        `insert into invites (id, email, invited_by, role, status, created_at) values (?, ?, ?, ?, 'accepted', ?)`,
      )
      .run(`inv-${id}`, email, ADMIN.id, role, now);
  };
  const synced = (email: string) =>
    row(`select access_synced_at as at from invites where email = '${email}'`)?.at;

  it('R-AUTH-10 remove clears access_synced_at, and a CLI renew keeps it clear until synced', async () => {
    const api = fakeAccess();
    await runInvite(['add', 'gone@example.test'], deps(api));
    expect(synced('gone@example.test')).not.toBeNull();
    await runInvite(['remove', 'gone@example.test'], deps(api));
    expect(synced('gone@example.test')).toBeNull();
    // Without the Access scope the renew cannot sync, so it stays clear.
    await runInvite(['add', 'gone@example.test'], deps(null));
    expect(synced('gone@example.test')).toBeNull();
  });

  it('R-AUTH-09 add reactivates a suspended member with an accepted invite, audits it, then syncs the policy', async () => {
    addMember('ann', 'ann@example.test', 'member', 'active');
    const api = fakeAccess();
    await runInvite(['remove', 'ann@example.test'], deps(api));
    expect(row(`select status from users where id = 'ann'`)).toEqual({ status: 'suspended' });
    expect(policyEmails(api)).toEqual([]);

    expect(await runInvite(['add', 'ann@example.test'], deps(api))).toBe(0);
    expect(row(`select status from users where id = 'ann'`)).toEqual({ status: 'active' });
    expect(
      row(
        `select action, actor_id from audit_events where entity_id = 'ann' and action = 'member.reactivated'`,
      ),
    ).toEqual({ action: 'member.reactivated', actor_id: null });
    expect(row(`select status from invites where id = 'inv-ann'`)).toEqual({ status: 'accepted' });
    expect(policyEmails(api)).toEqual(['ann@example.test']);
    expect(output.join('\n')).toContain('Reactivated ann@example.test.');
  });

  it('R-AUTH-09 add leaves a suspended member without an accepted invite out of the app, as the app does', async () => {
    addMember('bob', 'bob@example.test', 'member', 'suspended');
    sqlite.prepare(`update invites set status = 'revoked' where id = 'inv-bob'`).run();
    await runInvite(['add', 'bob@example.test', '--name', 'Bob'], deps(null));
    // The ordinary invite path: pending again, never straight to active.
    expect(row(`select status from users where id = 'bob'`)).toEqual({ status: 'invited' });
    expect(
      row(`select action from audit_events where action = 'member.reactivated'`),
    ).toBeUndefined();
  });

  it('R-AUTH-09 a reactivation that does not apply syncs nothing and fails', async () => {
    addMember('cy', 'cy@example.test', 'member', 'suspended');
    // A trigger stands in for a concurrent change: the guarded update finds no suspended row.
    sqlite.exec(
      `create trigger undo before update on users when old.id = 'cy' begin select raise(ignore); end`,
    );
    const api = fakeAccess();
    expect(await runInvite(['add', 'cy@example.test'], deps(api))).toBe(1);
    expect(api.requests).toEqual([]);
    expect(row(`select status from users where id = 'cy'`)).toEqual({ status: 'suspended' });
    expect(output.join('\n')).toContain('could not be reactivated');
  });

  it('R-NAV-06 removing the last active admin is refused in the update itself, with no audit and no policy change', async () => {
    const api = fakeAccess([ADMIN.email]);
    expect(await runInvite(['remove', ADMIN.email], deps(api))).toBe(1);
    expect(row(`select status from users where id = '${ADMIN.id}'`)).toEqual({ status: 'active' });
    expect(row(`select count(*) as n from audit_events where action = 'member.suspended'`)).toEqual(
      { n: 0 },
    );
    expect(api.requests).toEqual([]);
    expect(output.join('\n')).toContain('last active admin');
  });

  it('R-NAV-06 with a second active admin the first can be removed, then the second cannot', async () => {
    addMember('adm2', 'adm2@example.test', 'admin', 'active');
    expect(await runInvite(['remove', ADMIN.email], deps(null))).toBe(0);
    expect(row(`select status from users where id = '${ADMIN.id}'`)).toEqual({
      status: 'suspended',
    });
    expect(row(`select count(*) as n from audit_events where action = 'member.suspended'`)).toEqual(
      { n: 1 },
    );
    expect(await runInvite(['remove', 'adm2@example.test'], deps(null))).toBe(1);
    expect(row(`select status from users where id = 'adm2'`)).toEqual({ status: 'active' });
  });

  it('N7 the seat numbers and the seat count agree between the app and the CLI', () => {
    expect(SEAT_LIMIT).toBe(APP_SEAT_LIMIT);
    expect(APP_SEAT_WARNING).toBeLessThan(SEAT_LIMIT);
    // The CLI's expression counts active members plus live pending invites, as the app's.
    addMember('dee', 'dee@example.test', 'member', 'active');
    sqlite
      .prepare(
        `insert into invites (id, email, invited_by, status, created_at, expires_at) values ('p1', 'p1@example.test', ?, 'pending', 0, NULL), ('p2', 'p2@example.test', ?, 'pending', 0, 5), ('p3', 'p3@example.test', ?, 'revoked', 0, NULL)`,
      )
      .run(ADMIN.id, ADMIN.id, ADMIN.id);
    expect(row(`select ${seatsUsedSql(10)} as used`)).toEqual({ used: 3 });
  });
});

describe('scripts/invite.mjs (INV-9)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'classhub-invite-'));
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    for (const file of [
      'invite.mjs',
      'cf.mjs',
      'lib/invite.mjs',
      'lib/env-file.mjs',
      'lib/cf-child.mjs',
      'lib/ids.mjs',
    ]) {
      copyFileSync(join(repoRoot, 'scripts', file), join(dir, 'scripts', file));
    }
    mkdirSync(join(dir, 'src', 'lib', 'shared'), { recursive: true });
    for (const file of ['normalize.ts', 'seats.ts']) {
      copyFileSync(
        join(repoRoot, 'src', 'lib', 'shared', file),
        join(dir, 'src', 'lib', 'shared', file),
      );
    }
    copyFileSync(join(repoRoot, 'site.config.ts'), join(dir, 'site.config.ts'));
    copyFileSync(
      join(repoRoot, 'tests', 'fixtures', 'fake-wrangler.mjs'),
      join(dir, 'fake-wrangler.mjs'),
    );
    chmodSync(join(dir, 'fake-wrangler.mjs'), 0o755);
    // No ACCESS_POLICY_ID, so no Access call is attempted.
    writeFileSync(
      join(dir, '.env.cloudflare'),
      `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\n`,
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs D1 through the account guard, with the token in neither argv nor its own env', () => {
    const log = join(dir, 'wrangler.log');
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      CF_WRANGLER_BIN: join(dir, 'fake-wrangler.mjs'),
      FAKE_WRANGLER_LOG: log,
      FAKE_WRANGLER_WHOAMI: JSON.stringify({ accounts: [{ id: ACCOUNT }] }),
      FAKE_WRANGLER_STDOUT: JSON.stringify([{ results: [], success: true }]),
      CLOUDFLARE_API_TOKEN: 'inherited-token-must-not-pass',
    };
    const result = spawnSync(process.execPath, [join(dir, 'scripts', 'invite.mjs'), 'list'], {
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Access policy: not checked');
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; token: string | null });
    expect(calls.map((call) => call.args[0])).toEqual(['whoami', 'd1']);
    expect(calls[1]?.args.slice(0, 5)).toEqual(['d1', 'execute', 'DB', '--remote', '--json']);
    // cf.mjs supplies the .env.cloudflare token; the inherited one never reaches wrangler.
    expect(calls.every((call) => call.token === TOKEN)).toBe(true);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain(TOKEN);
  });
});
