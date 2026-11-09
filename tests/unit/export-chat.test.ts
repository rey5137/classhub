import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireBackupLock } from '../../scripts/lib/backup-lock.mjs';
import {
  checkArchiveContent,
  decryptFileWithAge,
  encryptFileWithAge,
  runExportChat,
  type ExportChatDeps,
} from '../../scripts/lib/export-chat.mjs';
import {
  createLocalDatabase,
  type LocalDatabase,
} from '../../src/lib/server/adapters/local/sqlite-database';
import { chatArchives, chatMessages, profileContacts, users } from '../../src/lib/server/db/schema';
import type { RealtimeHub } from '../../src/lib/server/ports/realtime';
import { completeDeletion } from '../../src/lib/server/services/members';
import {
  exportCandidates,
  ndjsonSha256,
  toNdjson,
} from '../../src/lib/server/repositories/chat-archive';

// Synthetic only (INV-6): made-up members and messages, a throwaway age key.
const recipient = `age1${'q'.repeat(58)}`;
const NOW = Date.UTC(2026, 10, 6, 12);
const DAY = 86_400_000;
const ageInstalled =
  spawnSync('age', ['--version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).status === 0;

let dir: string;
let database: LocalDatabase;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'classhub-export-chat-'));
  database = createLocalDatabase(join(dir, 'dev.sqlite'), { migrationsDir: 'migrations' });
  await database.db.insert(users).values({
    id: 'u1',
    authEmail: 'an@example.test',
    displayName: 'An',
    displayNameNorm: 'an',
    status: 'active',
  });
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `count` messages one hour apart, the oldest `startDaysAgo` days before NOW. */
async function seedMessages(
  count: number,
  startDaysAgo: number,
  deleted: number[] = [],
  sender: (index: number) => string = () => 'u1',
) {
  const start = NOW - startDaysAgo * DAY;
  for (let index = 0; index < count; index += 1) {
    const createdAt = start + index * 3_600_000;
    await database.db.insert(chatMessages).values({
      id: `m${String(index).padStart(4, '0')}`,
      roomId: 'main',
      senderId: sender(index),
      clientNonce: `n${index}`,
      body: deleted.includes(index) ? '' : `synthetic message ${index}`,
      createdAt,
      deletedAt: deleted.includes(index) ? createdAt : null,
    });
  }
}

const realtime: RealtimeHub = {
  connect: async () => new Response(null),
  disconnectMember: async () => {},
  notify: async () => {},
};

/** An admin and a member with a pending deletion request, plus contacts that must not leak. */
async function seedDeletionUsers(keepContent: boolean): Promise<void> {
  await database.db.insert(users).values([
    {
      id: 'u2',
      authEmail: 'admin@example.test',
      displayName: 'Admin',
      displayNameNorm: 'admin',
      status: 'active',
      role: 'admin',
    },
    {
      id: 'u3',
      authEmail: 'real.person@example.test',
      displayName: 'Real Person',
      displayNameNorm: 'real person',
      status: 'active',
      role: 'member',
      deletionRequestedAt: NOW - DAY,
      deletionKeepContent: keepContent,
    },
  ]);
  await database.db.insert(profileContacts).values({
    userId: 'u3',
    contactEmail: 'real.person@example.test',
    phone: '+1 555 0100',
    messagingUrl: 'https://chat.example.test/real-person',
    city: 'Synthetic City',
    bio: 'Synthetic bio',
  });
}

async function completeSeedDeletion(): Promise<void> {
  const outcome = await completeDeletion(
    { database, realtime },
    { id: 'u2', role: 'admin', displayName: 'Admin' },
    'u3',
    NOW,
  );
  expect(outcome).toEqual({ ok: true, changed: true });
}

function deps(overrides: Partial<ExportChatDeps> = {}): ExportChatDeps & { lines: string[] } {
  const lines: string[] = [];
  const identity = join(dir, 'key.txt');
  writeFileSync(identity, 'AGE-SECRET-KEY-SYNTHETIC');
  return {
    database,
    policy: { retainDays: 365, maxMessages: 5 },
    recipient,
    identity,
    outDir: join(dir, 'backups'),
    now: () => NOW,
    ageAvailable: () => true,
    // Stand-ins for age: the "ciphertext" is the plaintext, so the check reads what was written.
    encrypt: async (source, _recipient, destination) => copyFileSync(source, destination),
    decrypt: async (archive, _identity, destination) => copyFileSync(archive, destination),
    lockPath: join(dir, 'backup.lock'),
    tmpRoot: dir,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

/** The message ids of an NDJSON archive, in file order. */
const archivedIds = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{') && line.includes('"id"'))
    .map((line) => (JSON.parse(line) as { id: string }).id)
    .filter((id) => id.startsWith('m'));

const archiveRows = () => database.db.select().from(chatArchives);
const chatFiles = () =>
  existsSync(join(dir, 'backups', 'chat')) ? readdirSync(join(dir, 'backups', 'chat')) : [];
const stagingLeft = () => readdirSync(dir).filter((name) => name.startsWith('classhub-chat-'));

describe('export-chat', () => {
  it('R-CHAT-14 archives the messages beyond maxMessages into one verified file and row', async () => {
    // 10 hourly messages on one day; the newest 5 are kept.
    await seedMessages(10, 6.4);
    const d = deps();

    expect(await runExportChat(d)).toBe(0);

    const rows = await archiveRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      fileName: 'chat/m0000_m0004.ndjson.age',
      fromId: 'm0000',
      toId: 'm0004',
      recordCount: 5,
      exportedAt: NOW,
      verifiedAt: NOW,
      purgedAt: null,
    });
    const text = readFileSync(join(dir, 'backups', row!.fileName), 'utf8');
    expect(ndjsonSha256(text)).toBe(row!.sha256);
    expect(
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).id),
    ).toEqual(['m0000', 'm0001', 'm0002', 'm0003', 'm0004']);
    expect(stagingLeft()).toEqual([]);
    expect(existsSync(d.lockPath!)).toBe(false);
  });

  it('R-CHAT-14 splits candidates by UTC month into separate files', async () => {
    // Hourly from Oct 31 20:00 UTC: the first four are in October, the rest in November.
    const start = Date.UTC(2026, 9, 31, 20);
    for (let index = 0; index < 8; index += 1)
      await database.db.insert(chatMessages).values({
        id: `m${index}`,
        roomId: 'main',
        senderId: 'u1',
        clientNonce: `n${index}`,
        body: `synthetic ${index}`,
        createdAt: start + index * 3_600_000,
      });

    expect(await runExportChat(deps({ policy: { retainDays: 365, maxMessages: 2 } }))).toBe(0);

    expect((await archiveRows()).map((row) => [row.fileName, row.recordCount]).sort()).toEqual([
      ['chat/m0_m3.ndjson.age', 4],
      ['chat/m4_m5.ndjson.age', 2],
    ]);
  });

  it('R-CHAT-14 a second run archives nothing and writes nothing', async () => {
    await seedMessages(10, 6);
    expect(await runExportChat(deps())).toBe(0);
    const files = chatFiles();
    const d = deps();

    expect(await runExportChat(d)).toBe(0);

    expect(chatFiles()).toEqual(files);
    expect(await archiveRows()).toHaveLength(1);
    expect(d.lines.join('\n')).toMatch(/nothing to archive/);
  });

  it('R-CHAT-13 archives messages older than retainDays even under maxMessages', async () => {
    await seedMessages(4, 400);
    await database.db.insert(chatMessages).values({
      id: 'z-new',
      roomId: 'main',
      senderId: 'u1',
      clientNonce: 'z',
      body: 'recent',
      createdAt: NOW - DAY,
    });

    expect(await runExportChat(deps({ policy: { retainDays: 365, maxMessages: 100 } }))).toBe(0);

    expect((await archiveRows()).map((row) => [row.fileName, row.recordCount])).toEqual([
      ['chat/m0000_m0003.ndjson.age', 4],
    ]);
  });

  it('R-CHAT-15 omits deleted messages from the archive but keeps them inside the range', async () => {
    await seedMessages(10, 6, [1, 3]);

    expect(await runExportChat(deps())).toBe(0);

    const [row] = await archiveRows();
    expect(row).toMatchObject({ fromId: 'm0000', toId: 'm0004', recordCount: 3 });
    const text = readFileSync(join(dir, 'backups', row!.fileName), 'utf8');
    expect(archivedIds(text)).toEqual(['m0000', 'm0002', 'm0004']);
    // record_count and the SHA-256 describe exactly the file's content.
    expect(text.trim().split('\n')).toHaveLength(row!.recordCount);
    expect(ndjsonSha256(text)).toBe(row!.sha256);
  });

  it('AC-CHAT-16 refuses to write without an age recipient, before the lock or any read', async () => {
    await seedMessages(10, 6);
    for (const bad of [undefined, '', 'not-a-key']) {
      const d = deps({ recipient: bad });
      expect(await runExportChat(d)).toBe(1);
      expect(d.lines.join('\n')).toMatch(/age recipient/);
      expect(existsSync(d.lockPath!)).toBe(false);
    }
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    expect(await archiveRows()).toEqual([]);
  });

  it('AC-CHAT-16 refuses without age on PATH or without the identity to read the file back', async () => {
    await seedMessages(10, 6);
    const noAge = deps({ ageAvailable: () => false });
    expect(await runExportChat(noAge)).toBe(1);
    expect(noAge.lines.join('\n')).toMatch(/age is not on PATH/);
    const noIdentity = deps({ identity: join(dir, 'missing.txt') });
    expect(await runExportChat(noIdentity)).toBe(1);
    expect(noIdentity.lines.join('\n')).toMatch(/age identity/);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    expect(await archiveRows()).toEqual([]);
  });

  it('AC-CHAT-16 never overwrites an existing archive: a name collision aborts with nothing written', async () => {
    await seedMessages(10, 6);
    const [range] = await exportCandidates(database, { retainDays: 365, maxMessages: 5 }, NOW);
    const existing = join(dir, 'backups', range!.fileName);
    mkdirSync(join(dir, 'backups', 'chat'), { recursive: true });
    writeFileSync(existing, 'an earlier archive');
    const d = deps();

    expect(await runExportChat(d)).toBe(1);

    expect(readFileSync(existing, 'utf8')).toBe('an earlier archive');
    expect(chatFiles()).toEqual([range!.fileName.slice('chat/'.length)]);
    expect(await archiveRows()).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/already exists; nothing written/);
    expect(existsSync(d.lockPath!)).toBe(false);
  });

  it.each([
    ['a hard link', undefined],
    [
      'an exclusive copy where the drive has no hard links',
      () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    ],
  ])(
    'AC-CHAT-16 an archive appearing at the final name mid-run aborts with it untouched (%s)',
    async (_case, link) => {
      await seedMessages(10, 6);
      const [range] = await exportCandidates(database, { retainDays: 365, maxMessages: 5 }, NOW);
      const final = join(dir, 'backups', range!.fileName);
      const d = deps({
        link,
        encrypt: async (source, _recipient, destination) => {
          copyFileSync(source, destination);
          writeFileSync(final, 'written by someone else');
        },
      });

      expect(await runExportChat(d)).toBe(1);

      expect(readFileSync(final, 'utf8')).toBe('written by someone else');
      expect(chatFiles()).toEqual([range!.fileName.slice('chat/'.length)]);
      expect(await archiveRows()).toEqual([]);
      expect(d.lines.join('\n')).toMatch(/appeared during the run; nothing overwritten/);
    },
  );

  it('R-CHAT-14 writes to a drive without hard links (exFAT) through an exclusive copy', async () => {
    await seedMessages(10, 6);
    const d = deps({
      link: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    });

    expect(await runExportChat(d)).toBe(0);

    const [row] = await archiveRows();
    expect(row?.verifiedAt).toBe(NOW);
    expect(chatFiles()).toEqual([row!.fileName.slice('chat/'.length)]);
  });

  it('AC-CHAT-10 detects a truncated NDJSON file and records no verified_at', async () => {
    await seedMessages(10, 6);
    const d = deps({
      // A short write: the file on disk lost its tail.
      encrypt: async (source, _recipient, destination) => {
        const text = readFileSync(source);
        writeFileSync(destination, text.subarray(0, text.length - 20));
      },
    });

    expect(await runExportChat(d)).toBe(1);

    expect(await archiveRows()).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/failed verification .*cut off/);
    // The unverified file is gone, so the next run writes the range again.
    expect(chatFiles()).toEqual([]);
    expect(stagingLeft()).toEqual([]);
    expect(await runExportChat(deps())).toBe(0);
    expect(await archiveRows()).toHaveLength(1);
  });

  it('AC-CHAT-10 checkArchiveContent fails a file cut at a record boundary on count and hash', () => {
    const records = [1, 2].map((n) => ({
      id: `m${n}`,
      roomId: 'main',
      senderId: 'u1',
      clientNonce: `n${n}`,
      body: `synthetic ${n}`,
      createdAt: n,
      editedAt: null,
    }));
    const full = toNdjson(records);
    const expected = { sha256: ndjsonSha256(full), count: 2 };
    expect(checkArchiveContent(Buffer.from(full), expected)).toEqual([]);
    const cut = checkArchiveContent(Buffer.from(toNdjson(records.slice(0, 1))), expected);
    expect(cut).toEqual(
      expect.arrayContaining(['1 records where 2 were written', 'the SHA-256 differs']),
    );
  });

  it('R-CHAT-14 a message changed in the range before verification records nothing', async () => {
    await seedMessages(10, 6);
    const d = deps({
      decrypt: async (archive, _identity, destination) => {
        copyFileSync(archive, destination);
        await database.db.insert(chatMessages).values({
          id: 'm0002a',
          roomId: 'main',
          senderId: 'u1',
          clientNonce: 'late',
          body: 'slipped into the range',
          createdAt: NOW - 6 * DAY + 2 * 3_600_000,
        });
      },
    });

    expect(await runExportChat(d)).toBe(1);

    expect(d.lines.join('\n')).toMatch(/no longer holds the same messages/);
    expect(await archiveRows()).toEqual([]);
    expect(chatFiles()).toEqual([]);
  });

  it('R-CHAT-14 a held backup lock makes export-chat exit without writing', async () => {
    await seedMessages(10, 6);
    const d = deps();
    const release = acquireBackupLock('backup', d.lockPath);
    try {
      expect(await runExportChat(d)).toBe(1);
    } finally {
      release();
    }
    expect(d.lines.join('\n')).toMatch(/holds/);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    expect(await archiveRows()).toEqual([]);
  });

  it.skipIf(!ageInstalled)('R-CHAT-14 round-trips through the real age binary', async () => {
    await seedMessages(10, 6);
    const identity = join(dir, 'real-key.txt');
    expect(spawnSync('age-keygen', ['-o', identity], { stdio: 'ignore' }).status).toBe(0);
    const publicKey = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' }).stdout.trim();
    const d = deps({
      recipient: publicKey,
      identity,
      encrypt: encryptFileWithAge,
      decrypt: decryptFileWithAge,
    });

    expect(await runExportChat(d)).toBe(0);

    const [row] = await archiveRows();
    const file = join(dir, 'backups', row!.fileName);
    expect(readFileSync(file).subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    const out = join(dir, 'plain.ndjson');
    await decryptFileWithAge(file, identity, out);
    expect(ndjsonSha256(readFileSync(out, 'utf8'))).toBe(row!.sha256);
  });

  it('AC-PROF-06 a completed delete-content deletion is absent from the archive', async () => {
    await seedDeletionUsers(false);
    await seedMessages(10, 6, [], (index) => ([0, 2, 4].includes(index) ? 'u3' : 'u1'));
    await completeSeedDeletion();

    expect(await runExportChat(deps())).toBe(0);

    const [row] = await archiveRows();
    const text = readFileSync(join(dir, 'backups', row!.fileName), 'utf8');
    expect(archivedIds(text)).toEqual(['m0001', 'm0003']);
    expect(text).not.toMatch(/real\.person@example\.test|555 0100|chat\.example\.test/);
  });

  it('AC-PROF-06 a completed keep-content deletion stays in the archive without contact data', async () => {
    await seedDeletionUsers(true);
    await seedMessages(10, 6, [], (index) => ([0, 2, 4].includes(index) ? 'u3' : 'u1'));
    await completeSeedDeletion();

    expect(await runExportChat(deps())).toBe(0);

    const [row] = await archiveRows();
    const text = readFileSync(join(dir, 'backups', row!.fileName), 'utf8');
    expect(archivedIds(text)).toEqual(['m0000', 'm0001', 'm0002', 'm0003', 'm0004']);
    expect(text).toContain('"senderId":"u3"');
    expect(text).not.toMatch(/real\.person@example\.test|555 0100|chat\.example\.test/);
  });
});
