import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireBackupLock } from '../../scripts/lib/backup-lock.mjs';
import type { CfResult } from '../../scripts/lib/cf-child.mjs';
import { runExportChat } from '../../scripts/lib/export-chat.mjs';
import { runRestoreChat } from '../../scripts/lib/restore-chat.mjs';
import {
  createLocalDatabase,
  type LocalDatabase,
} from '../../src/lib/server/adapters/local/sqlite-database';
import { chatArchives, chatMessages, users } from '../../src/lib/server/db/schema';
import { pruneArchived } from '../../src/lib/server/repositories/chat-archive';
import { tombstoneEmail } from '../../src/lib/server/services/members';

// Synthetic only (INV-6): made-up members and messages; "age" is a copy here.
const NOW = Date.UTC(2026, 10, 6, 12);
const DAY = 86_400_000;
const VERIFIED_AT = NOW - DAY;

let dir: string;
let database: LocalDatabase;
let archive: string;
let original: (typeof chatMessages.$inferSelect)[];

const copy = async (from: string, _identity: string, to: string) => copyFileSync(from, to);

/** The cf.mjs calls backupGate makes: no deploy yet, and `verifiedAt` as the newest backup. */
function gateRun(verifiedAt: number | null) {
  const calls: string[][] = [];
  const run = (args: string[]): CfResult => {
    calls.push(args);
    if (args.join(' ') === 'deployments list --json')
      return { status: 0, stdout: '[]', stderr: '' };
    if (args.slice(0, 6).join(' ') === 'd1 execute DB --remote --json --command')
      return {
        status: 0,
        stdout: JSON.stringify([{ results: [{ at: verifiedAt }], success: true }]),
        stderr: '',
      };
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { run, calls };
}

function restore(overrides: Partial<Parameters<typeof runRestoreChat>[0]> = {}) {
  const lines: string[] = [];
  const result = runRestoreChat({
    database,
    run: gateRun(VERIFIED_AT).run,
    file: archive,
    identity: join(dir, 'key.txt'),
    decrypt: copy,
    lockPath: join(dir, 'backup.lock'),
    tmpRoot: dir,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    ...overrides,
  });
  return { result, lines };
}

const messages = () => database.db.select().from(chatMessages).orderBy(chatMessages.id);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'classhub-restore-chat-'));
  writeFileSync(join(dir, 'key.txt'), 'AGE-SECRET-KEY-SYNTHETIC');
  database = createLocalDatabase(join(dir, 'dev.sqlite'), { migrationsDir: 'migrations' });
  for (const id of ['u1', 'u2'])
    await database.db.insert(users).values({
      id,
      authEmail: `${id}@example.test`,
      displayName: id,
      displayNameNorm: id,
      status: 'active',
    });
  // Six old messages, three from each member, all archived by export-chat.
  for (let index = 0; index < 6; index += 1)
    await database.db.insert(chatMessages).values({
      id: `m${index}`,
      roomId: 'main',
      senderId: index % 2 ? 'u2' : 'u1',
      clientNonce: `n${index}`,
      body: `synthetic message ${index}`,
      createdAt: NOW - 400 * DAY + index * 3_600_000,
    });
  original = await messages();
  const lines: string[] = [];
  expect(
    await runExportChat({
      database,
      policy: { retainDays: 365, maxMessages: 1000 },
      recipient: `age1${'q'.repeat(58)}`,
      identity: join(dir, 'key.txt'),
      outDir: join(dir, 'backups'),
      now: () => NOW,
      ageAvailable: () => true,
      encrypt: async (source, _recipient, destination) => copyFileSync(source, destination),
      decrypt: copy,
      lockPath: join(dir, 'backup.lock'),
      tmpRoot: dir,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    }),
  ).toBe(0);
  const files = readdirSync(join(dir, 'backups', 'chat'));
  expect(files).toHaveLength(1);
  archive = join(dir, 'backups', 'chat', files[0]!);
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('npm run restore -- --chat', () => {
  it('R-CHAT-14, R-CHAT-15 a message deleted after the export survives prune as a tombstone and is not restored', async () => {
    const [{ exportedAt }] = (await database.db
      .select({ exportedAt: chatArchives.exportedAt })
      .from(chatArchives)) as [{ exportedAt: number }];
    // m1 was in the archive, then its author deleted it.
    await database.db
      .update(chatMessages)
      .set({ body: '', deletedAt: exportedAt + 5 })
      .where(eq(chatMessages.id, 'm1'));
    const pruned = await pruneArchived(database, { now: () => NOW, pause: async () => {} });
    expect(pruned).toMatchObject({ status: 'pruned', deleted: 5, remaining: false });
    expect(await messages()).toMatchObject([{ id: 'm1', body: '', deletedAt: exportedAt + 5 }]);
    // The range counts as cleared: a later prune has nothing to work on.
    expect(await pruneArchived(database, { now: () => NOW, pause: async () => {} })).toEqual({
      status: 'no-archive',
    });

    const { result, lines } = restore();
    expect(await result).toBe(0);
    expect(lines.join('\n')).toContain('5 messages added, 1 already there, 0 skipped');
    const after = await messages();
    expect(after.map((row) => row.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(after.find((row) => row.id === 'm1')).toMatchObject({
      body: '',
      deletedAt: exportedAt + 5,
    });
  });

  it('AC-CHAT-16 adds only the missing rows, never updates or deletes, and skips deleted members', async () => {
    // After the export: prune removed m0..m3, m4 was edited since, a new m9 arrived, and u2's
    // deletion completed (R-PROF-11: the tombstone email).
    await database.db.delete(chatMessages).where(eq(chatMessages.roomId, 'main'));
    await database.db.insert(chatMessages).values([
      { ...original[4]!, body: 'edited after the export', editedAt: NOW },
      { ...original[5]!, id: 'm9', clientNonce: 'n9', senderId: 'u1', body: 'new since' },
    ]);
    await database.db
      .update(users)
      .set({ authEmail: tombstoneEmail('u2'), status: 'suspended' })
      .where(eq(users.id, 'u2'));
    const { result, lines } = restore();
    expect(await result).toBe(0);
    expect(lines.join('\n')).toContain('2 messages added, 1 already there, 3 skipped');
    const after = await messages();
    expect(after.map((row) => row.id)).toEqual(['m0', 'm2', 'm4', 'm9']);
    // Restored rows are the archived ones; the edited and the new row are untouched.
    for (const id of ['m0', 'm2'])
      expect(after.find((row) => row.id === id)).toMatchObject({
        body: original.find((row) => row.id === id)!.body,
        createdAt: original.find((row) => row.id === id)!.createdAt,
        clientNonce: original.find((row) => row.id === id)!.clientNonce,
        senderId: 'u1',
      });
    expect(after.find((row) => row.id === 'm4')!.body).toBe('edited after the export');
    expect(after.find((row) => row.id === 'm9')!.body).toBe('new since');
    // No body reaches the output (R-CHAT-15 prints counts only).
    expect(lines.join('\n')).not.toContain('synthetic message');
    expect(existsSync(join(dir, 'backup.lock'))).toBe(false);
    expect(readdirSync(dir).filter((name) => name.startsWith('classhub-restore-chat-'))).toEqual(
      [],
    );
  });

  it('AC-CHAT-16 a second run adds nothing', async () => {
    await database.db.delete(chatMessages).where(eq(chatMessages.roomId, 'main'));
    expect(await restore().result).toBe(0);
    const once = await messages();
    const second = restore();
    expect(await second.result).toBe(0);
    expect(second.lines.join('\n')).toContain('0 messages added, 6 already there, 0 skipped');
    expect(await messages()).toEqual(once);
    expect(once).toEqual(original);
  });

  it.each([
    ['no verified backup', null, 'no verified backup exists'],
    ['an unreadable backup_runs', undefined, 'cannot read backup_runs'],
  ])('AC-CHAT-16 refuses with %s and writes nothing', async (_case, verifiedAt, message) => {
    await database.db.delete(chatMessages).where(eq(chatMessages.roomId, 'main'));
    const run =
      verifiedAt === undefined
        ? () => ({ status: 1, stdout: '', stderr: 'D1 unreachable' })
        : gateRun(verifiedAt).run;
    const { result, lines } = restore({
      run: (args) =>
        args[0] === 'deployments' ? { status: 0, stdout: '[]', stderr: '' } : run(args),
    });
    expect(await result).toBe(1);
    expect(lines.join('\n')).toContain(message);
    expect(lines.join('\n')).toContain('nothing restored');
    expect(await messages()).toEqual([]);
    expect(existsSync(join(dir, 'backup.lock'))).toBe(false);
  });

  it('AC-CHAT-16 refuses while the backup lock is held, before the gate or any read', async () => {
    await database.db.delete(chatMessages).where(eq(chatMessages.roomId, 'main'));
    const release = acquireBackupLock('backup', join(dir, 'backup.lock'));
    const gate = gateRun(VERIFIED_AT);
    try {
      const { result, lines } = restore({ run: gate.run });
      expect(await result).toBe(1);
      expect(lines.join('\n')).toMatch(
        /^restore --chat: another backup, export-chat, prune-chat or restore --chat holds .*"command":"backup"/,
      );
      expect(gate.calls).toEqual([]);
      expect(await messages()).toEqual([]);
    } finally {
      release();
    }
  });

  it('AC-CHAT-16 a held lock names restore --chat to the next command', async () => {
    const holder = restore({
      // Hold the lock open while the gate runs, then try a second command.
      run: (args) => {
        expect(() => acquireBackupLock('backup', join(dir, 'backup.lock'))).toThrow(
          /restore --chat/,
        );
        return gateRun(VERIFIED_AT).run(args);
      },
    });
    expect(await holder.result).toBe(0);
  });

  it('R-CHAT-15 refuses a file export-chat did not record, and one that does not match its record', async () => {
    const stray = join(dir, 'backups', 'chat', 'other.ndjson.age');
    copyFileSync(archive, stray);
    const unknown = restore({ file: stray });
    expect(await unknown.result).toBe(1);
    expect(unknown.lines.join('\n')).toContain('no verified chat archive is recorded');
    const altered = restore({
      decrypt: async (_from, _identity, to) => writeFileSync(to, '{"id":"x"}\n'),
    });
    expect(await altered.result).toBe(1);
    expect(altered.lines.join('\n')).toContain('does not match its recorded archive');
    expect(await messages()).toEqual(original);
  });
});
