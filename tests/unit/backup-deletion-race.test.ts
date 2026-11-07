import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { siteConfig } from '../../src/lib/config';
import {
  createLocalDatabase,
  type LocalDatabase,
} from '../../src/lib/server/adapters/local/sqlite-database';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage';
import { softDeletePhoto } from '../../src/lib/server/repositories/gallery';
import { JobRunner } from '../../src/lib/server/services/job-runner';
import { runBackup } from '../../scripts/lib/backup.mjs';
import type { CfResult } from '../../scripts/lib/cf-child.mjs';
import { verifySnapshot } from '../../scripts/lib/verify-backup.mjs';
import { dumpLikeD1 } from '../fixtures/d1-dump';
import { HOUSEKEEPING_NOW, seedDeletedMedia } from '../fixtures/housekeeping';
import { seedMembership } from '../fixtures/membership';

// R-BAK-16 / AC-BAK-10, second half, on the local adapters: the real schema in SQLite, the
// filesystem bucket, the app's own photo delete and housekeeping purge. Synthetic bytes only.
const DAY = 86_400_000;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const stream = (data: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(data));
      controller.close();
    },
  });

let dir: string;
let file: string;
let database: LocalDatabase;
let bucket: FsObjectStorage;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'classhub-race-test-'));
  for (const sub of ['tmp', 'out', 'inspect']) mkdirSync(join(dir, sub));
  file = join(dir, 'dev.sqlite');
  database = createLocalDatabase(file, { migrationsDir: 'migrations' });
  bucket = new FsObjectStorage(join(dir, 'bucket'));
  await seedMembership(database);
});
afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedPhoto() {
  const image = Buffer.from('synthetic race image');
  const thumb = Buffer.from('synthetic race thumb');
  const row = await seedDeletedMedia(database, {
    deletedAt: null,
    createdAt: HOUSEKEEPING_NOW - DAY,
    sizeBytes: image.length,
    thumbSizeBytes: thumb.length,
    sha256: sha(image),
    thumbSha256: sha(thumb),
  });
  const limits = { contentType: 'image/webp', maxBytes: 1024 };
  await bucket.put(row.objectKey, stream(image), limits);
  await bucket.put(row.thumbKey, stream(thumb), limits);
  return row;
}

/** cf.mjs stand-in over the local SQLite file: live counts, D1's clock, the export, lookups. */
function localRun(exportedAt: number) {
  return (args: string[], options: { input?: string } = {}): CfResult => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    const client = new Database(file, { readonly: true });
    try {
      if (args[0] === 'api') return ok('{}');
      if (args[0] === 'd1' && args[1] === 'execute')
        return ok(
          JSON.stringify(
            args[6]!.split(';\n').map((sql) => ({ results: client.prepare(sql).all() })),
          ),
        );
      if (args[0] === 'd1' && args[1] === 'export') {
        writeFileSync(args[args.indexOf('--output') + 1]!, dumpLikeD1(client));
        return ok('');
      }
      if (args[0] === 'd1-query') {
        const body = JSON.parse(options.input ?? '{}') as { sql: string; params: unknown[] };
        if (body.sql.startsWith('SELECT CAST(unixepoch'))
          return ok(JSON.stringify([{ results: { columns: ['now_ms'], rows: [[exportedAt]] } }]));
        if (body.sql.startsWith('INSERT INTO backup_runs')) return ok('[]');
        const rows = client
          .prepare(body.sql)
          .raw()
          .all(...body.params);
        return ok(JSON.stringify([{ results: { columns: [], rows } }]));
      }
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    } finally {
      client.close();
    }
  };
}

/**
 * The backup's S3 side over the local bucket. The first listing is the moment between the
 * SQL export and the object copy: the photo is deleted there and housekeeping runs at `purgeAt`.
 */
function racingStorage(mediaId: string, deletedAt: number, purgeAt: number) {
  let raced = false;
  return {
    async list(prefix: string, cursor?: string) {
      if (!raced) {
        raced = true;
        expect(await softDeletePhoto(database, mediaId, deletedAt)).toBe(true);
        await new JobRunner({ database, storage: bucket }).run(purgeAt);
      }
      return bucket.list(prefix, cursor);
    },
    async get(key: string, destination: string, expectedSize: number) {
      const object = await bucket.get(key);
      if (!object?.body) return null;
      const data = Buffer.from(await new Response(object.body).arrayBuffer());
      expect(data.length).toBe(expectedSize);
      writeFileSync(destination, data, { flag: 'wx' });
      return { size: data.length, sha256: sha(data) };
    },
  };
}

async function backUp(storage: ReturnType<typeof racingStorage>, exportedAt: number) {
  const errors: string[] = [];
  const code = await runBackup({
    run: localRun(exportedAt),
    storage,
    databaseId: '11111111-1111-4111-8111-111111111111',
    bucket: 'classhub-media',
    appVersion: '0.0.0-test',
    recipient: `age1${'q'.repeat(58)}`,
    outDir: join(dir, 'out'),
    ageAvailable: () => true,
    encrypt: async (stage, name, _recipient, destination) => {
      cpSync(join(stage, name), join(dir, 'inspect', name), { recursive: true });
      writeFileSync(destination, `encrypted ${name}`);
    },
    lockPath: join(dir, 'backup.lock'),
    tmpRoot: join(dir, 'tmp'),
    out: () => {},
    err: (line) => errors.push(line),
  });
  const [name] = readdirSync(join(dir, 'inspect'));
  return { code, errors, snapshot: join(dir, 'inspect', name!) };
}

describe('backup deletion race (R-BAK-16)', () => {
  it('AC-BAK-10 a photo deleted between the export and the copy still verifies: its objects wait out the grace period', async () => {
    const photo = await seedPhoto();
    const exportedAt = HOUSEKEEPING_NOW;
    // Deleted a minute after the export; housekeeping runs an hour later, well inside the grace.
    const storage = racingStorage(photo.id, exportedAt + 60_000, exportedAt + 3_600_000);
    const { code, errors, snapshot } = await backUp(storage, exportedAt);
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    const { errors: verifyErrors, manifest } = await verifySnapshot(snapshot);
    expect(verifyErrors).toEqual([]);
    // Copied, not skipped: the grace period kept both objects for the backup.
    expect(manifest!.skipped).toEqual([]);
    expect(readdirSync(join(snapshot, 'objects/media/v1', photo.id)).sort()).toEqual([
      'image.webp',
      'thumb.webp',
    ]);
    // The snapshot holds the photo as it was at the export: not deleted.
    expect(manifest!.portable['portable/media.ndjson']).toBe(1);
  });

  it('R-BAK-16 past the grace period the objects are purged, and the backup records them as skipped', async () => {
    const photo = await seedPhoto();
    const exportedAt = HOUSEKEEPING_NOW;
    const purgeAt = exportedAt + (siteConfig.deletedMediaGraceDays + 1) * DAY;
    const { code, errors, snapshot } = await backUp(
      racingStorage(photo.id, exportedAt + 60_000, purgeAt),
      exportedAt,
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    const { errors: verifyErrors, manifest } = await verifySnapshot(snapshot);
    expect(verifyErrors).toEqual([]);
    expect(manifest!.skipped.map((entry) => entry.key).sort()).toEqual(
      [photo.objectKey, photo.thumbKey].sort(),
    );
  });
});
