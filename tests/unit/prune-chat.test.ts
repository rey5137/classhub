import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireBackupLock } from '../../scripts/lib/backup-lock.mjs';
import { runBackup } from '../../scripts/lib/backup.mjs';
import { runExportChat } from '../../scripts/lib/export-chat.mjs';
import { ChatTargetError, chatDatabase } from '../../scripts/lib/chat-target.mjs';
import { runPruneChat } from '../../scripts/lib/prune-chat.mjs';
import {
  createLocalDatabase,
  type LocalDatabase,
} from '../../src/lib/server/adapters/local/sqlite-database';
import { chatArchives, chatMessages, users } from '../../src/lib/server/db/schema';

// Synthetic only (INV-6): one made-up member, generated messages, stand-ins for age.
const NOW = Date.UTC(2026, 10, 6, 12);
const recipient = `age1${'q'.repeat(58)}`;
let dir: string;
let database: LocalDatabase;
let lines: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'classhub-prune-chat-'));
  database = createLocalDatabase(join(dir, 'dev.sqlite'), { migrationsDir: 'migrations' });
  lines = [];
  await database.db.insert(users).values({
    id: 'u1',
    authEmail: 'an@example.test',
    displayName: 'An',
    displayNameNorm: 'an',
    status: 'active',
  });
  for (let index = 0; index < 12; index += 1)
    await database.db.insert(chatMessages).values({
      id: `m${String(index).padStart(2, '0')}`,
      roomId: 'main',
      senderId: 'u1',
      clientNonce: `n${index}`,
      body: `synthetic ${index}`,
      createdAt: NOW - 86_400_000 + index * 60_000,
    });
});
afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = () => join(dir, 'backup.lock');
const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
const prune = () =>
  runPruneChat({ database, lockPath: lockPath(), now: () => NOW, pause: async () => {}, ...io });
const exportChat = () => {
  const identity = join(dir, 'key.txt');
  writeFileSync(identity, 'AGE-SECRET-KEY-SYNTHETIC');
  return runExportChat({
    database,
    policy: { retainDays: 365, maxMessages: 8 },
    recipient,
    identity,
    outDir: join(dir, 'backups'),
    now: () => NOW,
    ageAvailable: () => true,
    encrypt: async (source, _recipient, destination) => copyFileSync(source, destination),
    decrypt: async (archive, _identity, destination) => copyFileSync(archive, destination),
    lockPath: lockPath(),
    tmpRoot: dir,
    ...io,
  });
};
const ids = async () =>
  (
    await database.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .orderBy(asc(chatMessages.id))
  ).map((row) => row.id);

describe('prune-chat CLI', () => {
  it('AC-CHAT-09 refuses with a clear message and exit 1 when nothing is archived', async () => {
    expect(await prune()).toBe(1);
    expect(lines.join('\n')).toMatch(/nothing deleted.*Run npm run export-chat first/);
    expect(await ids()).toHaveLength(12);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('AC-CHAT-09 after export-chat removes only the archived oldest messages', async () => {
    expect(await exportChat()).toBe(0);
    expect(await prune()).toBe(0);
    expect(await ids()).toEqual(['m04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11']);
    const [archive] = await database.db.select().from(chatArchives);
    expect(archive).toMatchObject({ fromId: 'm00', toId: 'm03', purgedAt: NOW });
    expect(lines.join('\n')).toMatch(/deleted 4 archived messages/);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('R-CHAT-18 a database failure exits 1, releases the lock and a rerun resumes', async () => {
    expect(await exportChat()).toBe(0);
    lines.length = 0;
    let calls = 0;
    const failing = runPruneChat({
      database,
      lockPath: lockPath(),
      now: () => NOW,
      chunk: 2,
      pause: async () => {
        calls += 1;
        throw new Error('SQLITE_BUSY with parameters m00');
      },
      ...io,
    });
    expect(await failing).toBe(1);
    expect(calls).toBe(1);
    expect(lines.join('\n')).not.toMatch(/m00/);
    expect(existsSync(lockPath())).toBe(false);
    expect(await prune()).toBe(0);
    expect(await ids()).toHaveLength(8);
  });

  describe('AC-BAK-06 backup lock pairing', () => {
    it('a held lock makes prune-chat exit without deleting', async () => {
      expect(await exportChat()).toBe(0);
      const release = acquireBackupLock('backup', lockPath());
      try {
        expect(await prune()).toBe(1);
      } finally {
        release();
      }
      expect(lines.join('\n')).toMatch(/holds/);
      expect(await ids()).toHaveLength(12);
      expect((await database.db.select().from(chatArchives))[0]?.purgedAt).toBeNull();
    });

    it('a held lock makes export-chat exit without writing', async () => {
      const release = acquireBackupLock('prune-chat', lockPath());
      try {
        expect(await exportChat()).toBe(1);
      } finally {
        release();
      }
      expect(existsSync(join(dir, 'backups'))).toBe(false);
      expect(await database.db.select().from(chatArchives)).toEqual([]);
    });

    it('a held prune-chat lock makes backup exit without a remote call or a file', async () => {
      const release = acquireBackupLock('prune-chat', lockPath());
      const run = vi.fn();
      const storage = { list: vi.fn(), get: vi.fn() };
      try {
        expect(
          await runBackup({
            run,
            storage,
            databaseId: '11111111-1111-4111-8111-111111111111',
            bucket: 'classhub-media',
            appVersion: '0.0.0-test',
            recipient,
            outDir: join(dir, 'out'),
            ageAvailable: () => true,
            lockPath: lockPath(),
            tmpRoot: dir,
            ...io,
          }),
        ).toBe(1);
      } finally {
        release();
      }
      expect(lines.join('\n')).toMatch(/backup: another backup, export-chat or prune-chat holds/);
      expect(run).not.toHaveBeenCalled();
      expect(storage.list).not.toHaveBeenCalled();
      expect(existsSync(join(dir, 'out'))).toBe(false);
    });
  });

  describe('--local target', () => {
    it('refuses a CLASSHUB_DB that names no file, and creates none', () => {
      const missing = join(dir, 'typo.sqlite');
      expect(() => chatDatabase(dir, { local: true, env: { CLASSHUB_DB: missing } })).toThrow(
        ChatTargetError,
      );
      expect(() => chatDatabase(dir, { local: true, env: {} })).toThrow(/does not exist/);
      expect(existsSync(missing)).toBe(false);
      expect(existsSync(join(dir, 'data'))).toBe(false);
    });

    it('refuses an empty CLASSHUB_DB with a clear message', () => {
      expect(() => chatDatabase(dir, { local: true, env: { CLASSHUB_DB: '' } })).toThrow(
        /CLASSHUB_DB is set but empty/,
      );
    });

    it('opens an existing database', async () => {
      // The repository root, for its migrations.
      const target = chatDatabase(process.cwd(), {
        local: true,
        env: { CLASSHUB_DB: join(dir, 'dev.sqlite') },
      });
      try {
        expect(
          await target.database.db.select({ id: chatMessages.id }).from(chatMessages),
        ).toHaveLength(12);
      } finally {
        target.close();
      }
    });
  });
});
