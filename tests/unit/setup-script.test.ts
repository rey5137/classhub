import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT, createSandbox, repoRoot, TOKEN, type Sandbox } from '../fixtures/script-sandbox';

// R-OPS-04 end to end: scripts/setup.mjs → scripts/cf.mjs → a stateful fake CLI
// and a loopback fake API, in a copy of the repo's scripts (AC-OPS-01, AC-PLAT-08).

const ADMIN = 'admin@example.test';

let box: Sandbox;
let dir: string;

beforeEach(async () => {
  box = await createSandbox();
  dir = box.dir;
});

afterEach(() => box.close());

const readState = () => box.readState();
const d1 = () => box.d1();
const setup = (flags: string[] = []) => box.run('setup.mjs', flags);
const wranglerVars = () =>
  (
    JSON.parse(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')) as {
      vars: Record<string, string>;
    }
  ).vars;
const api = {
  get requests() {
    return box.api.requests;
  },
};

const firstRun = ['--slug', 'classhub', '--title', 'Lớp 12A', '--locale', 'en', '--admin', ADMIN];

function summary(stdout: string): string {
  return stdout.slice(stdout.indexOf('Class Hub setup is complete:'));
}

// Each case spawns setup.mjs (~2 s alone); under the full verify run that exceeds vitest's 5 s default.
describe('scripts/setup.mjs (R-OPS-04)', { timeout: 30_000 }, () => {
  it('AC-OPS-01 a second run creates nothing, keeps members and settings, and prints the same values', async () => {
    const first = await setup(firstRun);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('D1 classhub-db: created.');
    expect(first.stdout).toContain('R2 classhub-media: created.');
    const secrets = readState().secrets;
    expect(Object.keys(secrets).sort()).toEqual([
      'INTERNAL_CONTEXT_KEY',
      'LOG_HASH_SALT',
      'VAPID_PRIVATE_KEY',
    ]);
    // R-NTF-01: the VAPID public key is a var next to its private secret, never in the output.
    const vapidPublicKey = wranglerVars().VAPID_PUBLIC_KEY;
    expect(vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(first.stdout).toContain('VAPID key pair: created.');
    expect(first.stdout).not.toContain(secrets.VAPID_PRIVATE_KEY);

    // Members and settings change between the runs; the rerun must keep both.
    const db = d1();
    const admin = db.prepare('select id from users where auth_email = ?').get(ADMIN) as {
      id: string;
    };
    db.prepare(
      `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at)
       values ('member-1', 'binh@example.test', 'Bình', 'binh', 'member', 'active', 1, 1)`,
    ).run();
    db.prepare(`update site_settings set value_json = '"Lớp 12B"' where key = 'name'`).run();
    db.prepare(
      `update site_settings set value_json = '"unlocked"' where key = 'setup_state'`,
    ).run();
    db.close();

    // No flags at all: nothing is asked again, so no terminal and no --admin is needed.
    const second = await setup();
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('D1 classhub-db: exists, reused.');
    expect(second.stdout).toContain('R2 classhub-media: exists, reused.');
    expect(second.stdout).toContain('Secret INTERNAL_CONTEXT_KEY: exists, kept.');
    // A rerun never replaces the pair: that would silence every subscribed device.
    expect(second.stdout).toContain('VAPID key pair: exists, kept.');
    expect(wranglerVars().VAPID_PUBLIC_KEY).toBe(vapidPublicKey);
    expect(second.calls.filter((call) => call[1] === 'create' || call[2] === 'create')).toEqual([]);
    expect(second.calls.some((call) => call[0] === 'secret' && call[1] === 'put')).toBe(false);
    expect(summary(second.stdout)).toBe(summary(first.stdout));

    const state = readState();
    expect(state.databases.map((entry) => entry.name)).toEqual(['classhub-db']);
    expect(state.buckets).toEqual(['classhub-media']);
    expect(state.secrets).toEqual(secrets);
    const after = d1();
    expect(after.prepare('select auth_email from users order by auth_email').pluck().all()).toEqual(
      [ADMIN, 'binh@example.test'],
    );
    expect(after.prepare('select id from users where auth_email = ?').get(ADMIN)).toEqual(admin);
    expect(
      Object.fromEntries(
        after
          .prepare('select key, value_json from site_settings')
          .all()
          .map((row) => {
            const { key, value_json } = row as { key: string; value_json: string };
            return [key, JSON.parse(value_json) as string];
          }),
      ),
    ).toEqual({ setup_state: 'unlocked', name: 'Lớp 12B', theme: 'yearbook', locale: 'en' });
    after.close();
  });

  it('R-OPS-04 refuses when the VAPID secret exists but the public var is empty, before any secret put or config write', async () => {
    await setup(firstRun);
    const configPath = join(dir, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      vars: Record<string, string>;
    };
    config.vars.VAPID_PUBLIC_KEY = '';
    writeFileSync(configPath, JSON.stringify(config));
    // A lost INTERNAL_CONTEXT_KEY would otherwise be put before the VAPID step.
    const statePath = join(box.stateDir, 'state.json');
    const state = readState();
    const privateKey = state.secrets.VAPID_PRIVATE_KEY;
    delete state.secrets.INTERNAL_CONTEXT_KEY;
    writeFileSync(statePath, JSON.stringify(state));

    const rerun = await setup();
    expect(rerun.status).not.toBe(0);
    expect(rerun.stderr).toContain('VAPID_PUBLIC_KEY');
    expect(rerun.stderr).toContain('/api/v1/notifications');
    expect(rerun.calls.some((call) => call[0] === 'secret' && call[1] === 'put')).toBe(false);
    expect(readState().secrets.VAPID_PRIVATE_KEY).toBe(privateKey);
    expect(wranglerVars().VAPID_PUBLIC_KEY).toBe('');
  });

  it('R-OPS-04 warns instead of "exists, kept" when the public var is set but the secret is missing', async () => {
    await setup(firstRun);
    const state = readState();
    delete state.secrets.VAPID_PRIVATE_KEY;
    writeFileSync(join(box.stateDir, 'state.json'), JSON.stringify(state));
    const rerun = await setup();
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).not.toContain('VAPID key pair: exists, kept.');
    expect(rerun.stdout).toContain('WARNING');
    expect(
      rerun.calls.some((call) => call[0] === 'secret' && call[2] === 'VAPID_PRIVATE_KEY'),
    ).toBe(false);
  });

  it('AC-OPS-01 prints the values the owner needs and never a secret or the token', async () => {
    const result = await setup(firstRun);
    const [database] = readState().databases;
    expect(summary(result.stdout).split('\n').slice(1, 7)).toEqual([
      `  Account id:           ${ACCOUNT}`,
      '  Worker hostname:      classhub.fake-sub.workers.dev',
      `  D1 database:          classhub-db (${database!.uuid})`,
      '  R2 bucket:            classhub-media',
      `  Bootstrap admin:      ${ADMIN}`,
      '  Google redirect URI:  https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback',
    ]);
    const printed = `${result.stdout}${result.stderr}`;
    for (const secret of [TOKEN, ...Object.values(readState().secrets)]) {
      expect(printed).not.toContain(secret);
    }
    // Secrets travel on stdin: no argument of any CLI call carries one.
    const argv = readState().calls.flat().join(' ');
    for (const secret of Object.values(readState().secrets)) expect(argv).not.toContain(secret);
    // The Cloudflare API only ever saw the guarded token, from cf.mjs.
    expect(api.requests.every((line) => line.endsWith(' token'))).toBe(true);
  });

  it('AC-OPS-01 seeds the bootstrap admin invite, an explicit lock and no demo content', async () => {
    await setup(firstRun);
    const db = d1();
    expect(db.prepare('select auth_email, role, status from users').all()).toEqual([
      { auth_email: ADMIN, role: 'admin', status: 'invited' },
    ]);
    // R-AUTH-12: the bootstrap admin is the admin whose invite names themselves.
    expect(
      db
        .prepare(
          'select i.status, i.expires_at from invites i join users u on u.id = i.invited_by and u.auth_email = i.email',
        )
        .all(),
    ).toEqual([{ status: 'pending', expires_at: null }]);
    expect(
      db.prepare(`select value_json from site_settings where key = 'setup_state'`).pluck().get(),
    ).toBe('"locked"');
    for (const table of ['posts', 'albums', 'media', 'profile_contacts']) {
      expect(db.prepare(`select count(*) from ${table}`).pluck().get()).toBe(0);
    }
    db.close();
  });

  it('AC-OPS-01 never adds a bootstrap admin over existing members', async () => {
    await setup(firstRun);
    const db = d1();
    db.prepare('delete from audit_events').run();
    db.prepare('delete from invites').run();
    db.prepare(`update users set auth_email = 'other@example.test', role = 'member'`).run();
    db.close();

    const result = await setup(['--admin', 'new-admin@example.test']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Bootstrap admin:      none (members exist; setup adds nobody)',
    );
    const after = d1();
    expect(after.prepare('select auth_email from users').pluck().all()).toEqual([
      'other@example.test',
    ]);
    expect(after.prepare('select count(*) from invites').pluck().get()).toBe(0);
    after.close();
  });

  describe('correcting the bootstrap admin email (R-OPS-04 step 6)', () => {
    const rows = () => {
      const db = d1();
      const out = {
        users: db.prepare('select auth_email, display_name, display_name_norm from users').all(),
        invites: db.prepare('select email from invites').pluck().all(),
        audits: db.prepare('select count(*) from audit_events').pluck().get(),
      };
      db.close();
      return out;
    };

    it('AC-OPS-01 replaces the address while the admin has not signed in, in users and invites together', async () => {
      await setup(firstRun);
      const before = rows();
      const marked = d1();
      marked.prepare('update invites set access_synced_at = 12345').run();
      marked.close();
      const result = await setup(['--admin', 'Right.Admin@Example.test']);
      expect(result.status).toBe(0);
      const check = d1();
      expect(check.prepare('select access_synced_at from invites').pluck().all()).toEqual([null]);
      check.close();
      expect(result.stdout).toContain(`npm run invite -- remove ${ADMIN}`);
      expect(result.stdout).toContain('npm run invite -- add right.admin@example.test');
      expect(rows()).toEqual({
        users: [
          {
            auth_email: 'right.admin@example.test',
            display_name: 'right.admin',
            display_name_norm: 'right.admin',
          },
        ],
        invites: ['right.admin@example.test'],
        // No audit row for the rewrite.
        audits: before.audits,
      });
      expect(result.stdout).toContain('right.admin@example.test');
    });

    it('AC-OPS-01 keeps the address when the answer is the same or the default', async () => {
      await setup(firstRun);
      const before = rows();
      expect((await setup(['--admin', ADMIN])).status).toBe(0);
      expect((await setup()).status).toBe(0);
      expect(rows()).toEqual(before);
    });

    it.each([
      ['signed in (has an Access subject)', `update users set access_sub = 'sub-1'`],
      ['active', `update users set status = 'active'`],
    ])('AC-OPS-01 never rewrites an admin who has %s', async (_name, change) => {
      await setup(firstRun);
      const db = d1();
      db.prepare(change).run();
      db.close();
      const before = rows();
      const result = await setup(['--admin', 'right.admin@example.test']);
      expect(result.status).toBe(0);
      expect(rows()).toEqual(before);
    });

    it('AC-OPS-01 refuses an address that already belongs to another user or invite, before any write', async () => {
      await setup(firstRun);
      const db = d1();
      db.prepare(
        `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) values ('u2', 'taken@example.test', 'T', 't', 'member', 'invited', 1, 1)`,
      ).run();
      db.prepare(
        `insert into invites (id, email, invited_by, role, status, created_at) select 'i2', 'pending.only@example.test', id, 'member', 'revoked', 1 from users where id = 'u2'`,
      ).run();
      db.close();
      const before = rows();
      for (const email of ['taken@example.test', 'Pending.Only@example.test']) {
        const result = await setup(['--admin', email]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('already belongs to another member or invite');
        expect(result.stderr).not.toMatch(/UNIQUE|constraint/i);
        expect(rows()).toEqual(before);
      }
    });
  });

  it('AC-PLAT-08 generates wrangler.jsonc with the configured account, and Git ignores it', async () => {
    await setup(firstRun);
    const config = JSON.parse(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')) as Record<
      string,
      unknown
    >;
    const [database] = readState().databases;
    expect(config).toMatchObject({
      name: 'classhub',
      account_id: ACCOUNT,
      workers_dev: true,
      preview_urls: false,
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'classhub-db',
          database_id: database!.uuid,
          migrations_dir: 'migrations',
        },
      ],
      r2_buckets: [{ binding: 'MEDIA', bucket_name: 'classhub-media' }],
      durable_objects: { bindings: [{ name: 'CHAT_ROOM', class_name: 'ChatRoom' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['ChatRoom'] }],
      vars: { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' },
    });

    const ignored = spawnSync('git', ['check-ignore', '--no-index', '-q', 'wrangler.jsonc'], {
      cwd: repoRoot,
    });
    expect(ignored.status).toBe(0);
  });

  it('R-AUTH-05 a rerun writes the Access vars from .env.cloudflare and keeps what the owner added', async () => {
    await setup(firstRun);
    const path = join(dir, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // An owner edit with a comment: an owner var, a custom-domain route, a second DO tag.
    writeFileSync(
      path,
      `// edited by hand\n${JSON.stringify({
        ...config,
        vars: { ...(config.vars as object), ACCESS_AUD: 'aud-kept', OWNER_VAR: '1' },
        routes: [{ pattern: 'class.example.test', custom_domain: true }],
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['ChatRoom'] },
          { tag: 'v2', renamed_classes: [] },
        ],
      })}`,
    );
    writeFileSync(
      join(dir, '.env.cloudflare'),
      `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\nACCESS_TEAM_DOMAIN=myteam\nACCESS_AUD=\n`,
    );

    const result = await setup();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Google redirect URI:  https://myteam.cloudflareaccess.com/cdn-cgi/access/callback',
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      account_id: ACCOUNT,
      vars: { ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: 'aud-kept', OWNER_VAR: '1' },
      routes: [{ pattern: 'class.example.test', custom_domain: true }],
      migrations: [{ tag: 'v1' }, { tag: 'v2' }],
    });
  });

  it('refuses before creating anything when wrangler.jsonc names another account', async () => {
    writeFileSync(
      join(dir, 'wrangler.jsonc'),
      JSON.stringify({ name: 'classhub', account_id: '44444444444444444444444444444444' }),
    );
    const result = await setup(firstRun);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'wrangler.jsonc names account 44444444444444444444444444444444',
    );
    expect(result.calls).toEqual([]);
    expect(readState().databases).toEqual([]);
  });

  it('asks for the admin email it cannot default, instead of inventing one', async () => {
    const result = await setup(['--slug', 'classhub']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pass --admin');
    const db = d1();
    expect(db.prepare('select count(*) from users').pluck().get()).toBe(0);
    db.close();
  });

  it('refuses a slug that cannot name the Worker and its resources', async () => {
    const result = await setup(['--slug', 'Class_Hub', '--admin', ADMIN]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the slug is');
    expect(readState().databases).toEqual([]);
  });

  it('finds the bucket by name when it sorts past the first page of the account list', async () => {
    const others = Array.from({ length: 24 }, (_, index) => `a-${String(index).padStart(2, '0')}`);
    box.writeState({ ...readState(), buckets: [...others, 'classhub-media'] });

    const result = await setup(firstRun);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('R2 classhub-media: exists, reused.');
    expect(result.calls.some((call) => call[0] === 'r2')).toBe(false);
    expect(api.requests).toContain(
      `GET /client/v4/accounts/${ACCOUNT}/r2/buckets/classhub-media token`,
    );
  });

  it('creates a missing bucket exactly once (404 means missing)', async () => {
    const first = await setup(firstRun);
    const second = await setup();
    const creates = [...first.calls, ...second.calls].filter(
      (call) => call[0] === 'r2' && call[2] === 'create',
    );
    expect(creates).toEqual([
      ['r2', 'bucket', 'create', 'classhub-media', '--update-config=false'],
    ]);
  });

  it('stops, creating nothing, when the bucket lookup fails for another reason', async () => {
    box.writeState({ ...readState(), failures: { 'api bucket': 'forbidden' } });
    const result = await setup(firstRun);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot check R2 bucket classhub-media');
    expect(result.calls.some((call) => call[0] === 'r2')).toBe(false);
    expect(readState().buckets).toEqual([]);
  });

  it('keeps an owner’s workers_dev: false on a rerun (the custom-domain fallback)', async () => {
    await setup(firstRun);
    const path = join(dir, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(config.workers_dev).toBe(true);
    writeFileSync(path, JSON.stringify({ ...config, workers_dev: false }));

    expect((await setup()).status).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ workers_dev: false });
  });

  it('takes the release keys from wrangler.jsonc.example on a rerun', async () => {
    await setup(firstRun);
    const path = join(dir, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        main: 'old/worker.ts',
        compatibility_date: '2024-01-01',
        compatibility_flags: [],
        assets: { binding: 'OLD', directory: 'old' },
      }),
    );
    const example = JSON.parse(readFileSync(join(dir, 'wrangler.jsonc.example'), 'utf8')) as Record<
      string,
      unknown
    >;

    expect((await setup()).status).toBe(0);
    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const key of ['main', 'compatibility_date', 'compatibility_flags', 'assets']) {
      expect(after[key], key).toEqual(example[key]);
    }
  });

  it('appends the example’s missing Durable Object bindings and tags, keeping the owner’s order', async () => {
    await setup(firstRun);
    const path = join(dir, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // An older config: no CHAT_ROOM binding and no v1 tag, but owner entries of its own.
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        durable_objects: { bindings: [{ name: 'OWNER_DO', class_name: 'OwnerThing' }] },
        migrations: [{ tag: 'v0', new_sqlite_classes: ['OwnerThing'] }],
      }),
    );

    expect((await setup()).status).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      durable_objects: {
        bindings: [
          { name: 'OWNER_DO', class_name: 'OwnerThing' },
          { name: 'CHAT_ROOM', class_name: 'ChatRoom' },
        ],
      },
      migrations: [
        { tag: 'v0', new_sqlite_classes: ['OwnerThing'] },
        { tag: 'v1', new_sqlite_classes: ['ChatRoom'] },
      ],
    });

    // A rerun with everything present changes nothing: no duplicates, no reorder.
    const before = readFileSync(path, 'utf8');
    expect((await setup()).stdout).toContain('wrangler.jsonc: unchanged.');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
