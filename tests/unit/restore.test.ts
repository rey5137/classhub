import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRestoreArgs } from '../../scripts/restore.mjs';
import { runBackup } from '../../scripts/lib/backup.mjs';
import {
  isRestoreTargetRead,
  RESTORE_FOREIGN_KEY_CHECK,
  RESTORE_IMPORT_GUARD,
  RESTORE_IMPORT_GUARD_DROP,
  RESTORE_IMPORT_TAIL,
  RESTORE_TARGET_TABLES,
} from '../../scripts/lib/backup-sql.mjs';
import type { CfResult } from '../../scripts/lib/cf-child.mjs';
import { runRestore } from '../../scripts/lib/restore.mjs';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage';
import { seedDemo } from '../../src/lib/server/db/seed-demo';
import { resolveMember } from '../../src/lib/server/auth/membership';
import { dumpLikeD1 } from '../fixtures/d1-dump';

// restoreLocal's moves into place, so one test can fail the second of them.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

// Synthetic only (INV-6): the demo seed, generated photos, made-up ids and keys.
const root = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(root, 'migrations');
const liveDatabaseId = '11111111-1111-4111-8111-111111111111';
const newDatabaseId = '22222222-2222-4222-8222-222222222222';
const live = { databaseId: liveDatabaseId, databaseName: 'classhub', bucket: 'classhub-media' };
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let dir: string;
let snapshot: string;
let source: Database.Database;
/** A fresh scratch dir and demo snapshot; `tweak` is SQL run on the live copy before the backup. */
async function setUp(tweak = '') {
  dir = mkdtempSync(join(tmpdir(), 'classhub-restore-test-'));
  for (const sub of ['tmp', 'out', 'inspect', 'data']) mkdirSync(join(dir, sub));
  snapshot = await demoSnapshot(tweak);
}
/** Replaces this test's snapshot with one of a live site changed by `tweak`. */
async function retake(tweak: string) {
  source.close();
  rmSync(dir, { recursive: true, force: true });
  await setUp(tweak);
}
beforeEach(() => setUp());
afterEach(() => {
  source?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every key under an FsObjectStorage root with its bytes (no .meta/.tmp). */
function objectsIn(objectsDir: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(objectsDir, sub), { withFileTypes: true })) {
      if (!sub && entry.name.startsWith('.')) continue;
      const key = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(key);
      else found.set(key, readFileSync(join(objectsDir, key)));
    }
  };
  walk('');
  return found;
}

/**
 * The demo site as D1 would hold it (d1_migrations, an Access subject, a push subscription, a
 * theme), backed up by the real `runBackup` against fakes; returns the staged snapshot dir.
 */
async function demoSnapshot(tweak: string): Promise<string> {
  const file = join(dir, 'live.sqlite');
  const database = createLocalDatabase(file, { migrationsDir });
  await seedDemo(database, new FsObjectStorage(join(dir, 'live-objects')));
  database.close();
  source = new Database(file);
  const [admin] = source.prepare("select id from users where role = 'admin' limit 1").all() as {
    id: string;
  }[];
  source.exec(`
    update users set access_sub = 'old-sub-' || id;
    insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, locale, device_label, created_at, updated_at)
      values ('ps1', '${admin!.id}', 'https://push.example.test/1', 'p', 'a', 'en', 'Phone', 1, 1);
    insert into site_settings (key, value_json, updated_at) values ('theme', '{"preset":"sunrise"}', 1)
      on conflict (key) do update set value_json = excluded.value_json;
    create table d1_migrations (id integer primary key autoincrement, name text unique, applied_at text);
    insert into d1_migrations (name) select name from _local_migrations order by name;
    drop table _local_migrations;
  `);
  source.exec(tweak);
  const sql = dumpLikeD1(source);
  const objects = objectsIn(join(dir, 'live-objects'));
  const run = (args: string[], options: { input?: string } = {}): CfResult => {
    const ok = (stdout = '{}') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'api') return ok();
    if (args.slice(0, 6).join(' ') === 'd1 execute DB --remote --json --command')
      return ok(
        JSON.stringify(
          args[6]!.split(';\n').map((statement) => ({
            results: source.prepare(statement).all(),
            success: true,
          })),
        ),
      );
    if (args[0] === 'd1' && args[1] === 'export') {
      writeFileSync(args[args.indexOf('--output') + 1]!, sql);
      return ok('');
    }
    const body = JSON.parse(options.input ?? '{}') as { sql: string };
    if (body.sql?.startsWith('SELECT deleted_at FROM media'))
      return ok(JSON.stringify([{ results: { columns: ['deleted_at'], rows: [[null]] } }]));
    if (body.sql?.startsWith('SELECT CAST(unixepoch'))
      return ok(
        JSON.stringify([{ results: { columns: ['now_ms'], rows: [[Date.UTC(2026, 10, 5)]] } }]),
      );
    if (body.sql?.startsWith('INSERT INTO backup_runs')) return ok('[]');
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  const keys = [...objects.keys()].sort();
  const code = await runBackup({
    run,
    storage: {
      list: async (prefix: string) => ({
        objects: keys
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, size: objects.get(key)!.length })),
      }),
      get: async (key: string, destination: string) => {
        const data = objects.get(key)!;
        writeFileSync(destination, data, { flag: 'wx' });
        return { size: data.length, sha256: sha(data) };
      },
    },
    databaseId: liveDatabaseId,
    bucket: live.bucket,
    appVersion: '0.0.0-test',
    recipient: `age1${'q'.repeat(58)}`,
    outDir: join(dir, 'out'),
    ageAvailable: () => true,
    encrypt: async (stage: string, name: string, _recipient: string, destination: string) => {
      cpSync(join(stage, name), join(dir, 'inspect', name), { recursive: true });
      writeFileSync(destination, 'encrypted');
    },
    lockPath: join(dir, 'backup.lock'),
    tmpRoot: join(dir, 'tmp'),
    out: () => {},
    err: () => {},
  });
  expect(code).toBe(0);
  return join(dir, 'inspect', readdirSync(join(dir, 'inspect'))[0]!);
}

/**
 * A new D1 database and bucket the fakes hold: `cf.mjs d1 info / execute <name>` and S3.
 * `racing`: another import holds the guard but began after this run's emptiness check;
 * `afterImport` changes the database as a faulty import would; `put` may alter a body.
 */
function newTarget(
  options: {
    tables?: boolean;
    object?: boolean;
    uuid?: string;
    racing?: boolean;
    afterImport?: string;
    exposure?: { managed?: unknown; custom?: unknown; apiFails?: boolean };
    put?: (key: string, body: Buffer) => Buffer | null;
  } = {},
) {
  const target = new Database(':memory:');
  if (options.tables) target.exec('create table leftover (id text)');
  if (options.racing) target.exec(RESTORE_IMPORT_GUARD);
  const bucket = new Map<string, Buffer>();
  if (options.object) bucket.set('media/v1/x/image.webp', Buffer.from('left over'));
  const calls: string[][] = [];
  const imported: string[] = [];
  const events: string[] = [];
  const run = vi.fn((args: string[]): CfResult => {
    calls.push(args);
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'api') {
      // The reads preflight makes of a bucket's public access (cf.mjs allows only these).
      const exposure = options.exposure;
      if (exposure?.apiFails) return { status: 1, stdout: '', stderr: 'HTTP 500' };
      if (args[1] === '/r2/buckets/restored-media/domains/managed')
        return ok(JSON.stringify(exposure?.managed ?? { enabled: false }));
      if (args[1] === '/r2/buckets/restored-media/domains/custom')
        return ok(JSON.stringify(exposure?.custom ?? { domains: [] }));
    }
    if (args.join(' ') === 'd1 info restored --json')
      return ok(JSON.stringify({ uuid: options.uuid ?? newDatabaseId, name: 'restored' }));
    if (args.slice(0, 4).join(' ') === 'd1 execute restored --remote' && args[4] === '--file') {
      // D1 defers foreign keys for the import (the dump's PRAGMA defer_foreign_keys).
      target.pragma('foreign_keys = OFF');
      imported.push(readFileSync(args[5]!, 'utf8'));
      events.push('import');
      try {
        target.exec(imported.at(-1)!);
      } catch (error) {
        return { status: 1, stdout: '', stderr: (error as Error).message };
      } finally {
        target.pragma('foreign_keys = ON');
      }
      if (options.afterImport) target.exec(options.afterImport);
      return ok('');
    }
    if (args.slice(0, 6).join(' ') === 'd1 execute restored --remote --json --command') {
      // cf.mjs's rule for a restore target (tested in cf.test.ts): one pinned read, whole.
      expect(isRestoreTargetRead(args[6]!)).toBe(true);
      events.push(`read:${args[6]}`);
      const prepared = target.prepare(args[6]!);
      expect(prepared.reader).toBe(true);
      const results = (prepared.all() as { name?: string }[]).filter(
        // The racing import's guard appeared only after this run read the tables.
        (row) => !(options.racing && row.name === '_classhub_restore_guard'),
      );
      return ok(JSON.stringify([{ results, success: true }]));
    }
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  });
  const storage = {
    list: vi.fn(async (prefix: string) => ({
      objects: [...bucket.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: bucket.get(key)!.length })),
    })),
    put: vi.fn(async (key: string, body: Buffer) => {
      events.push('put');
      const stored = options.put ? options.put(key, Buffer.from(body)) : Buffer.from(body);
      if (stored) bucket.set(key, stored);
    }),
    get: vi.fn(async (key: string, destination: string) => {
      const data = bucket.get(key);
      if (!data) return null;
      writeFileSync(destination, data, { flag: 'wx' });
      return { size: data.length, sha256: sha(data) };
    }),
  };
  return { target, bucket, run, storage, calls, imported, events };
}

function restoreNew(fake: ReturnType<typeof newTarget>, overrides: Record<string, unknown> = {}) {
  const errors: string[] = [];
  const lines: string[] = [];
  const promise = runRestore({
    source: snapshot,
    root,
    target: {
      kind: 'new',
      run: fake.run,
      database: 'restored',
      bucket: 'restored-media',
      live,
      storage: fake.storage,
      ...overrides,
    },
    tmpRoot: join(dir, 'tmp'),
    out: (line: string) => lines.push(line),
    err: (line: string) => errors.push(line),
  });
  return { promise, errors, lines };
}

const localTarget = () => ({
  kind: 'local' as const,
  dbFile: join(dir, 'data', 'dev.sqlite'),
  objectsDir: join(dir, 'data', 'objects'),
});

function counts(db: Database.Database): Record<string, number> {
  const names = (
    db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_%' escape '\\' order by name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return Object.fromEntries(
    names.map((name) => [
      name,
      (db.prepare(`select count(*) as n from "${name}"`).get() as { n: number }).n,
    ]),
  );
}

describe('npm run restore --target local', () => {
  it('AC-BAK-01, R-BAK-07 restores the demo backup into a fresh data/: equal counts, hashes, theme and chat, not locked', async () => {
    const errors: string[] = [];
    const target = localTarget();
    expect(
      await runRestore({
        source: snapshot,
        root,
        target,
        out: () => {},
        err: (l: string) => errors.push(l),
      }),
    ).toBe(0);
    expect(errors).toEqual([]);
    const restored = new Database(target.dbFile, { readonly: true });
    try {
      const expected: Record<string, number> = { ...counts(source), push_subscriptions: 0 };
      expect(counts(restored)).toEqual(expected);
      expect(expected.chat_messages).toBeGreaterThan(0);
      for (const table of ['chat_messages', 'media', 'posts', 'users'])
        expect(
          restored
            .prepare(`select * from ${table} order by id`)
            .all()
            .map((row) => ({ ...(row as object), access_sub: undefined })),
        ).toEqual(
          source
            .prepare(`select * from ${table} order by id`)
            .all()
            .map((row) => ({ ...(row as object), access_sub: undefined })),
        );
      expect(
        restored.prepare("select value_json from site_settings where key = 'theme'").pluck().get(),
      ).toBe('{"preset":"sunrise"}');
      // R-BAK-06: no push subscription, no Access subject; R-BAK-07: setup_state as backed up,
      // so `dev:offline` opens the restored site.
      expect(
        restored.prepare('select count(*) from users where access_sub is not null').pluck().get(),
      ).toBe(0);
      expect(
        restored
          .prepare("select value_json from site_settings where key = 'setup_state'")
          .pluck()
          .get(),
      ).toBe('"unlocked"');
    } finally {
      restored.close();
    }
    const before = objectsIn(join(dir, 'live-objects'));
    const after = objectsIn(target.objectsDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, data] of before) expect(sha(after.get(key)!)).toBe(sha(data));
    // The local adapter opens it as is: every migration counts as applied, none re-runs.
    const opened = createLocalDatabase(target.dbFile, { migrationsDir });
    opened.close();
    expect(readdirSync(join(dir, 'data')).filter((name) => name.includes('restoring'))).toEqual([]);
  });

  it('R-BAK-06, AC-AUTH-14 a restored member logs in with a new Access sub and is matched by email', async () => {
    const target = localTarget();
    expect(await runRestore({ source: snapshot, root, target, out: () => {}, err: () => {} })).toBe(
      0,
    );
    const member = source
      .prepare(
        "select id, auth_email as email from users where status = 'active' order by id limit 1",
      )
      .get() as { id: string; email: string };
    const restored = createLocalDatabase(target.dbFile, { migrationsDir });
    try {
      const resolved = await resolveMember(restored, {
        email: member.email,
        subject: 'sub-after-restore',
      });
      expect(resolved?.id).toBe(member.id);
      const raw = new Database(target.dbFile, { readonly: true });
      expect(raw.prepare('select access_sub from users where id = ?').pluck().get(member.id)).toBe(
        'sub-after-restore',
      );
      // Re-linking a cleared subject is not a changed one (R-AUTH-25): no audit event.
      expect(
        raw
          .prepare("select count(*) from audit_events where action = 'access_sub_changed'")
          .pluck()
          .get(),
      ).toBe(0);
      raw.close();
    } finally {
      restored.close();
    }
  });

  it('AC-BAK-03 a directory without completed: true is rejected and nothing is written', async () => {
    const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'));
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({ ...manifest, completed: false }),
    );
    const errors: string[] = [];
    const fake = newTarget();
    expect(
      await runRestore({
        source: snapshot,
        root,
        target: localTarget(),
        out: () => {},
        err: (l: string) => errors.push(l),
      }),
    ).toBe(1);
    expect(errors.join('\n')).toContain('lacks completed: true');
    expect(readdirSync(join(dir, 'data'))).toEqual([]);
    const refused = restoreNew(fake);
    expect(await refused.promise).toBe(1);
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.storage.put).not.toHaveBeenCalled();
  });

  it('R-BAK-07 refuses an existing database file or a non-empty objects directory', async () => {
    const target = localTarget();
    writeFileSync(target.dbFile, '');
    const errors: string[] = [];
    expect(
      await runRestore({
        source: snapshot,
        root,
        target,
        out: () => {},
        err: (l: string) => errors.push(l),
      }),
    ).toBe(1);
    expect(errors.join('\n')).toContain('already exists');
    rmSync(target.dbFile);
    mkdirSync(join(target.objectsDir, 'media'), { recursive: true });
    expect(
      await runRestore({
        source: snapshot,
        root,
        target,
        out: () => {},
        err: (l: string) => errors.push(l),
      }),
    ).toBe(1);
    expect(errors.join('\n')).toContain('is not empty');
    expect(existsSync(target.dbFile)).toBe(false);
  });

  it('R-BAK-07 a run that cannot move the objects into place leaves nothing, so the next one restores', async () => {
    const target = localTarget();
    const { renameSync: actualRename } = await vi.importActual<typeof import('node:fs')>('node:fs');
    // Whichever of the two moves into place comes second fails.
    let moves = 0;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if ((to === target.objectsDir || to === target.dbFile) && ++moves === 2)
        throw new Error('rename failed');
      actualRename(from, to);
    });
    try {
      await expect(
        runRestore({ source: snapshot, root, target, out: () => {}, err: () => {} }),
      ).rejects.toThrow('rename failed');
    } finally {
      vi.mocked(renameSync).mockImplementation(actualRename);
    }
    // What had moved first is gone again, with both temporaries.
    expect(readdirSync(join(dir, 'data'))).toEqual([]);
    expect(await runRestore({ source: snapshot, root, target, out: () => {}, err: () => {} })).toBe(
      0,
    );
    expect(existsSync(target.dbFile)).toBe(true);
  });
});

describe('npm run restore --target new', () => {
  it('AC-BAK-04 a successful restore re-verifies, empties push, clears subjects and leaves the site locked', async () => {
    const fake = newTarget();
    const { promise, errors } = restoreNew(fake);
    const code = await promise;
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(counts(fake.target)).toEqual({ ...counts(source), push_subscriptions: 0 });
    expect(
      fake.target.prepare('select count(*) from users where access_sub is not null').pluck().get(),
    ).toBe(0);
    expect(
      fake.target
        .prepare("select value_json from site_settings where key = 'setup_state'")
        .pluck()
        .get(),
    ).toBe('"locked"');
    const objects = objectsIn(join(dir, 'live-objects'));
    expect(fake.bucket.size).toBe(objects.size);
    for (const [key, data] of objects) expect(sha(fake.bucket.get(key)!)).toBe(sha(data));
    // R-BAK-06 order: emptiness checks, the import (ending with the clears and the lock), the
    // copy, then read-only checks; no write reaches the new database but the import.
    expect(fake.calls[0]!.join(' ')).toBe('d1 info restored --json');
    expect(fake.events[0]).toBe(`read:${RESTORE_TARGET_TABLES}`);
    expect(fake.events.filter((event) => event === 'import')).toHaveLength(1);
    expect(fake.events[1]).toBe('import');
    // The file opens with the guard (no IF NOT EXISTS) and ends with the clears, the lock and
    // the guard's drop.
    expect(fake.imported[0]!.startsWith(`${RESTORE_IMPORT_GUARD};\n`)).toBe(true);
    expect(RESTORE_IMPORT_GUARD).not.toMatch(/if not exists/i);
    expect(
      fake.imported[0]!.trimEnd().endsWith(
        [...RESTORE_IMPORT_TAIL, RESTORE_IMPORT_GUARD_DROP].map((s) => `${s};`).join('\n'),
      ),
    ).toBe(true);
    expect(
      fake.target
        .prepare("select count(*) from sqlite_master where name like '_classhub%'")
        .pluck()
        .get(),
    ).toBe(0);
    const firstRead = fake.events.findIndex(
      (event, index) => index > 1 && event.startsWith('read:'),
    );
    expect(fake.events.lastIndexOf('put')).toBeLessThan(firstRead);
    expect(fake.events.slice(firstRead).every((event) => event.startsWith('read:'))).toBe(true);
    expect(fake.events).toContain(`read:${RESTORE_FOREIGN_KEY_CHECK}`);
    expect(fake.events).toContain('read:SELECT count(*) AS n FROM push_subscriptions');
    // The import file lived in the scratch directory only.
    expect(
      readdirSync(join(dir, 'tmp')).filter((name) => name.startsWith('classhub-restore-')),
    ).toEqual([]);
  });

  it.each([
    ['the live database name', { database: 'classhub' }, 'is the live database'],
    ['the live database binding', { database: 'DB' }, 'is the live database'],
    ['the live bucket', { bucket: 'classhub-media' }, 'is the live bucket'],
  ])('AC-BAK-04 refuses %s before any remote call', async (_case, override, message) => {
    const fake = newTarget();
    const { promise, errors } = restoreNew(fake, override);
    expect(await promise).toBe(1);
    expect(errors.join('\n')).toContain(message);
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.storage.list).not.toHaveBeenCalled();
  });

  it.each([
    ['a database whose id is the live binding', { uuid: liveDatabaseId }, 'is the live database'],
    ['a non-empty database', { tables: true }, 'is not empty (1 tables)'],
    ['a non-empty bucket', { object: true }, 'bucket restored-media is not empty'],
    [
      'a bucket with a public r2.dev URL',
      { exposure: { managed: { enabled: true } } },
      'public r2.dev URL enabled',
    ],
    [
      'a bucket with a custom domain',
      { exposure: { custom: { domains: [{ domain: 'media.example.test' }] } } },
      'a custom domain is connected',
    ],
    [
      'a bucket whose public access cannot be read',
      { exposure: { apiFails: true } },
      'r2.dev status unreadable',
    ],
  ])('AC-BAK-04 refuses %s and writes nothing', async (_case, setup, message) => {
    const fake = newTarget(setup);
    const { promise, errors } = restoreNew(fake);
    expect(await promise).toBe(1);
    expect(errors.join('\n')).toContain(message);
    expect(fake.calls.some((args) => args[4] === '--file')).toBe(false);
    expect(fake.storage.put).not.toHaveBeenCalled();
  });

  it('AC-BAK-04 refuses a backup of another schema version, naming the app version to check out', async () => {
    // A whole, verified backup of a site at schema version 99: only restore's own rule refuses it.
    await retake("update schema_meta set value = '99' where key = 'schema_version';");
    const fake = newTarget();
    const { promise, errors } = restoreNew(fake);
    expect(await promise).toBe(1);
    expect(errors.join('\n')).toContain(
      'the backup has schema version 99, this checkout 1; check out Class Hub 0.0.0-test',
    );
    expect(errors.join('\n')).not.toContain('FAIL');
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an extra trigger',
      'create trigger users_extra after update on users begin select 1; end;',
      'trigger users_extra is not in this checkout',
    ],
    [
      'a changed column',
      'alter table push_subscriptions rename column device_label to label;',
      'table push_subscriptions differs',
    ],
  ])(
    'R-BAK-06 refuses a backup whose schema has %s, before any remote call',
    async (_case, tweak, message) => {
      await retake(tweak);
      const fake = newTarget();
      const { promise, errors } = restoreNew(fake);
      expect(await promise).toBe(1);
      expect(errors.join('\n')).toContain(
        "database.sql's schema is not the one its migrations create",
      );
      expect(errors.join('\n')).toContain(message);
      expect(fake.run).not.toHaveBeenCalled();
    },
  );

  it('R-BAK-06 restores a backup with no setup_state row, which the lock adds', async () => {
    // A site never unlocked has no row (it counts as locked); the import's lock inserts one.
    await retake("delete from site_settings where key = 'setup_state';");
    const fake = newTarget();
    const { promise, errors, lines } = restoreNew(fake);
    expect(await promise).toBe(0);
    expect(errors).toEqual([]);
    expect(lines.join('\n')).toContain('restore: OK');
    expect(
      fake.target
        .prepare("select value_json from site_settings where key = 'setup_state'")
        .pluck()
        .get(),
    ).toBe('"locked"');
  });

  it.each([
    [
      'an object stored with other bytes',
      { put: (_key: string, body: Buffer) => ((body[0]! ^= 1), body) },
      'differs from the backup after the copy',
    ],
    [
      'an object missing after the copy',
      {
        // The first object never lands.
        put: (() => {
          let dropped = false;
          return (_key: string, body: Buffer) => (dropped ? body : ((dropped = true), null));
        })(),
      },
      "does not hold exactly the backup's objects",
    ],
    [
      'a media row without its object',
      {
        afterImport:
          "update media set object_key = 'media/v1/missing/image.webp' where id = (select min(id) from media where deleted_at is null);",
      },
      'has no matching media/v1/missing/image.webp',
    ],
    [
      'a table short of a row',
      { afterImport: "delete from site_settings where key = 'theme';" },
      'site_settings holds',
    ],
  ])(
    'R-BAK-06 fails, names it and reports no success after the import: %s',
    async (_case, setup, message) => {
      const fake = newTarget(setup);
      const { promise, errors, lines } = restoreNew(fake);
      expect(await promise).toBe(1);
      expect(fake.events).toContain('import');
      expect(errors.join('\n')).toContain(message);
      expect(errors.join('\n')).toContain('partly written; nothing touched the live site');
      expect(lines.join('\n')).not.toContain('restore: OK');
    },
  );

  it('R-BAK-06 a second import racing into the same database fails at the guard and merges nothing', async () => {
    const fake = newTarget({ racing: true });
    const { promise, errors, lines } = restoreNew(fake);
    expect(await promise).toBe(1);
    expect(errors.join('\n')).toContain('importing database.sql failed');
    expect(
      fake.target.prepare("select count(*) from sqlite_master where name = 'users'").pluck().get(),
    ).toBe(0);
    expect(fake.storage.put).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain('restore: OK');
  });

  it('R-DB-12 refuses a backup whose applied migrations differ from this checkout', async () => {
    const sqlPath = join(snapshot, 'database.sql');
    const sql = readFileSync(sqlPath, 'utf8').replace(
      /INSERT INTO "d1_migrations" [^\n]*0006_[^\n]*\n/,
      '',
    );
    writeFileSync(sqlPath, sql);
    resealDatabase(snapshot);
    const fake = newTarget();
    const { promise, errors } = restoreNew(fake);
    expect(await promise).toBe(1);
    expect(errors.join('\n')).toContain("migrations differ from this checkout's (1 missing");
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('R-BAK-06 a failed import says the new database may be partly written and stops before any copy', async () => {
    const fake = newTarget();
    const run = fake.run.getMockImplementation()!;
    fake.run.mockImplementation((args: string[]) =>
      args[4] === '--file' ? { status: 1, stdout: '', stderr: 'import failed' } : run(args),
    );
    const { promise, errors } = restoreNew(fake);
    expect(await promise).toBe(1);
    expect(errors.join('\n')).toContain('partly written; nothing touched the live site');
    expect(fake.storage.put).not.toHaveBeenCalled();
  });
});

/** After database.sql changes: its checksum line, the manifest's hash, size and counts. */
function resealDatabase(snap: string) {
  const sql = readFileSync(join(snap, 'database.sql'));
  const sums = readFileSync(join(snap, 'checksums.sha256'), 'utf8').replace(
    /^[0-9a-f]{64} {2}database\.sql$/m,
    `${sha(sql)}  database.sql`,
  );
  writeFileSync(join(snap, 'checksums.sha256'), sums);
  const manifest = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8'));
  manifest.database = { path: 'database.sql', sha256: sha(sql), bytes: sql.length };
  manifest.tables.d1_migrations -= 1;
  writeFileSync(join(snap, 'manifest.json'), JSON.stringify(manifest));
}

/** A port nothing listens on now, for the dev server's --strictPort. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });

describe('AC-BAK-05 restore --target local, then dev:offline', () => {
  const BUDGET_MS = 180_000;
  let server: ChildProcess | undefined;
  const stop = () => {
    if (!server?.pid || server.exitCode !== null) return;
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  };
  afterEach(stop);

  it(
    'AC-BAK-05 opens the restored demo site with no Cloudflare credentials in the environment',
    async () => {
      // Watchdog: a dev server that hangs is killed, so the run fails instead of waiting.
      const watchdog = setTimeout(stop, BUDGET_MS - 10_000);
      process.once('exit', stop);
      try {
        // R-BAK-07: nothing Cloudflare reaches either child, not even an account id.
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env))
          if (!/^(?:CLOUDFLARE_|CF_|R2_|WRANGLER|ACCESS_|AGE_|GMAIL_|TURNSTILE_)/.test(key))
            env[key] = value;
        env.CLASSHUB_DB = join(dir, 'data', 'dev.sqlite');
        env.CLASSHUB_OBJECTS = join(dir, 'data', 'objects');
        const restored = spawnSync(
          process.execPath,
          ['--import', 'tsx', 'scripts/restore.mjs', snapshot, '--target', 'local'],
          { cwd: root, env, encoding: 'utf8', timeout: 120_000 },
        );
        expect(restored.status, restored.stderr).toBe(0);
        expect(restored.stdout).toContain('npm run dev:offline');

        const admin = source
          .prepare("select auth_email from users where role = 'admin' order by id limit 1")
          .pluck()
          .get() as string;
        const title = source
          .prepare('select title from posts where deleted_at is null order by id limit 1')
          .pluck()
          .get() as string;
        const port = await freePort();
        server = spawn(
          'npm',
          ['run', 'dev:offline', '--', '--port', String(port), '--strictPort'],
          {
            cwd: root,
            env: { ...env, CLASSHUB_DEV_MEMBER: admin },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000));
        server.stdout?.on('data', keep);
        server.stderr?.on('data', keep);
        const base = `http://127.0.0.1:${port}`;
        const get = (path: string) =>
          fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000), redirect: 'manual' });
        const deadline = Date.now() + BUDGET_MS - 30_000;
        let up = false;
        while (!up && Date.now() < deadline) {
          if (server.exitCode !== null) throw new Error(`dev:offline exited:\n${output}`);
          up = await get('/health')
            .then((response) => response.ok)
            .catch(() => false);
          if (!up) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(up, output).toBe(true);
        // The restored board, as the restored admin re-linked by email (R-AUTH-25).
        const page = await get('/discussions');
        expect(page.status, output).toBe(200);
        const html = await page.text();
        expect(html).toContain(title);
      } finally {
        clearTimeout(watchdog);
        process.removeListener('exit', stop);
        stop();
      }
    },
    BUDGET_MS,
  );
});

describe('restore CLI arguments', () => {
  it('R-BAK-06 parses the three forms and refuses anything else', () => {
    expect(
      parseRestoreArgs(['a.tar.age', '--target', 'new', '--database', 'd', '--bucket', 'b']),
    ).toEqual({
      source: 'a.tar.age',
      values: { '--target': 'new', '--database': 'd', '--bucket': 'b' },
    });
    expect(parseRestoreArgs(['dir', '--target', 'local'])?.values['--target']).toBe('local');
    expect(
      parseRestoreArgs(['--chat', 'chat/x.ndjson.age', '--identity', 'k'])?.values['--chat'],
    ).toBe('chat/x.ndjson.age');
    for (const args of [
      [],
      ['a.tar.age'],
      ['a.tar.age', '--target', 'new'],
      ['a.tar.age', '--target', 'new', '--database', 'd'],
      ['a.tar.age', '--target', 'local', '--bucket', 'b'],
      ['a.tar.age', '--target', 'live'],
      ['a', 'b', '--target', 'local'],
      ['--chat', 'x', '--target', 'local'],
      ['x', '--chat', 'y'],
      ['a', '--target', 'local', '--target', 'local'],
      ['a', '--target', 'local', '--force', 'yes'],
    ])
      expect(parseRestoreArgs(args), args.join(' ')).toBeNull();
  });
});
