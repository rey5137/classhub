import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../../src/lib/config';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import {
  albums,
  media,
  rateEvents,
  storageUsage,
  uploadReservations,
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import { finalKeys, findReservation } from '../../src/lib/server/repositories/media';
import { Sha256 } from '../../src/lib/server/sha256';
import { resolveMediaRoute } from '../fixtures/media-routes';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

let database: Database;
let storage: R2ObjectStorage;
let harness: Harness;
let auth: Record<string, string>;
const root = '/api/v1/media/reservations';
const webp = new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80, 1, 2, 3, 4]);
const png = new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4, 255, 217]);
const digest = (data: Uint8Array) => {
  const hash = new Sha256();
  hash.update(data);
  return hash.digestHex();
};
const stream = (data: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
const input = (data = webp) => ({
  purpose: 'photo',
  imageBytes: data.length,
  thumbBytes: data.length,
  sha256: digest(data),
  thumbSha256: digest(data),
  mimeType: data === jpeg ? 'image/jpeg' : 'image/webp',
  width: 1600,
  height: 1200,
});
const jsonHeaders = () => ({ ...auth, origin: ORIGIN, 'content-type': 'application/json' });
async function reserve(overrides = {}) {
  const response = await harness.send(root, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ ...input(), ...overrides }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; mediaId: string; expiresAt: number };
}
async function put(
  id: string,
  variant = 'image',
  data = webp,
  headers = auth,
  mime = 'image/webp',
) {
  return harness.send(`${root}/${id}/${variant}`, {
    method: 'PUT',
    headers: { ...headers, origin: ORIGIN, 'content-type': mime },
    body: stream(data),
  });
}
async function finish(id: string, body = {}, headers = auth) {
  return harness.send(`${root}/${id}/complete`, {
    method: 'POST',
    headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function abandon(id: string, headers = auth) {
  return harness.send(`${root}/${id}`, {
    method: 'DELETE',
    headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
  });
}
async function usage() {
  const [row] = await database.db.select().from(storageUsage).limit(1);
  return { reserved: row!.reservedBytes, committed: row!.committedBytes };
}
async function keys() {
  return (await storage.list('')).objects.map((row) => row.key).sort();
}
async function uploaded(overrides = {}, data = webp) {
  const reservation = await reserve({ ...input(data), ...overrides });
  expect((await put(reservation.id, 'image', data, auth, input(data).mimeType)).status).toBe(200);
  if ((overrides as { purpose?: string }).purpose !== 'avatar')
    expect((await put(reservation.id, 'thumb', data, auth, input(data).mimeType)).status).toBe(200);
  return reservation;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  storage = new R2ObjectStorage(
    env.MEDIA as unknown as ConstructorParameters<typeof R2ObjectStorage>[0],
  );
  await seedMembership(database);
  harness = await createHarness(database, { storage, resolve: resolveMediaRoute });
  auth = await harness.as(PEOPLE.active.email);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await storage.delete(await keys());
  await database.db.delete(media);
  await database.db.delete(uploadReservations);
  await database.db.delete(albums);
  await database.db.delete(rateEvents);
  await database.db.update(storageUsage).set({ committedBytes: 0, reservedBytes: 0 });
});

describe('private media upload protocol on D1/R2', () => {
  it.each([
    ['wrong signature', png, { sha256: digest(png) }, 400],
    ['over reserved size', new Uint8Array([...webp, 5]), {}, 413],
    ['hash mismatch', webp, { sha256: '0'.repeat(64) }, 400],
    ['short body', webp.subarray(0, 12), {}, 400],
  ] as const)(
    'AC-MEM-04 %s refuses without an object or ledger change',
    async (_name, body, overrides, status) => {
      const reservation = await reserve(overrides);
      const before = await usage();
      const response = await put(reservation.id, 'image', body);
      expect(response.status).toBe(status);
      expect(errorBodySchema.safeParse(await response.json()).success).toBe(true);
      expect(await keys()).toEqual([]);
      expect(await usage()).toEqual(before);
    },
  );

  it('AC-MEM-04 undeclared media types get 415 and no staging object', async () => {
    const reservation = await reserve();
    const before = await usage();
    expect((await put(reservation.id, 'image', webp, auth, 'image/png')).status).toBe(415);
    expect((await put(reservation.id, 'image', webp, auth, 'image/jpeg')).status).toBe(400);
    expect(await keys()).toEqual([]);
    expect(await usage()).toEqual(before);
  });

  it('R-MEM-06 validates dimensions, sizes, hashes, purpose and metadata before reserving', async () => {
    for (const overrides of [
      { width: 0 },
      { height: 20001 },
      { width: 1.5 },
      { height: undefined },
      { imageBytes: -1 },
      { thumbBytes: 0 },
      { sha256: 'bad' },
      { mimeType: 'image/png' },
      { purpose: 'unknown' },
      { imageBytes: siteConfig.uploads.maxImageBytes + 1 },
      { thumbBytes: siteConfig.uploads.maxImageBytes + 1 },
    ]) {
      const response = await harness.send(root, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ...input(), ...overrides }),
      });
      expect(response.status).toBe(400);
    }
    expect(await usage()).toEqual({ reserved: 0, committed: 0 });
    expect(await database.db.select().from(uploadReservations).limit(50)).toEqual([]);
    expect((await finish(uuidv7(), { caption: 'x'.repeat(501) })).status).toBe(400);
    expect((await put(uuidv7(), 'other')).status).toBe(400);
  });

  it('R-MEM-06 R-MEM-17 site uploads are admin-only and avatars have one 512px object', async () => {
    const denied = await harness.send(root, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...input(), purpose: 'site' }),
    });
    expect(denied.status).toBe(403);
    const admin = await harness.as(PEOPLE.admin.email);
    const site = await harness.send(root, {
      method: 'POST',
      headers: { ...admin, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input(), purpose: 'site' }),
    });
    expect(site.status).toBe(201);
    const avatar = await uploaded({
      purpose: 'avatar',
      width: 512,
      height: 512,
      thumbBytes: 0,
      thumbSha256: digest(new Uint8Array()),
    });
    expect((await put(avatar.id, 'thumb')).status).toBe(404);
    expect((await finish(avatar.id)).status).toBe(201);
    const [row] = await database.db.select().from(media).limit(1);
    expect(row!.objectKey).toBe(`avatars/v1/${PEOPLE.active.id}/${avatar.mediaId}.webp`);
    expect(row!.thumbKey).toBe('');
    const image = await harness.send(`/api/v1/media/${avatar.mediaId}/image`, { headers: auth });
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await usage()).toEqual({ reserved: webp.length * 2, committed: webp.length });
  });

  it('AC-MEM-05 twenty concurrent reservations cannot overshoot the stop threshold', async () => {
    const total = webp.length * 2;
    await database.db
      .update(storageUsage)
      .set({ committedBytes: siteConfig.limits.mediaStopBytes - total });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        harness.send(root, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(input()),
        }),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.every((response) => [201, 507].includes(response.status))).toBe(true);
    expect(await usage()).toEqual({
      reserved: total,
      committed: siteConfig.limits.mediaStopBytes - total,
    });
    expect(await keys()).toEqual([]);
  });

  it('AC-MEM-06 at 9GB new reservations get 507 while committed media remains readable', async () => {
    const reservation = await uploaded();
    expect((await finish(reservation.id)).status).toBe(201);
    await database.db
      .update(storageUsage)
      .set({ committedBytes: siteConfig.limits.mediaStopBytes });
    const before = await usage();
    const beforeKeys = await keys();
    const response = await harness.send(root, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(507);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'storage_full',
    );
    const image = await harness.send(`/api/v1/media/${reservation.mediaId}/image`, {
      headers: auth,
    });
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(webp);
    expect(await usage()).toEqual(before);
    expect(await keys()).toEqual(beforeKeys);
  });

  it('R-MEM-13 photo daily and concurrent limits return 429 with Retry-After; avatars skip daily limit', async () => {
    const first = await reserve();
    await reserve();
    const response = await harness.send(root, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    await abandon(first.id);
    await database.db.insert(rateEvents).values(
      Array.from({ length: 25 }, () => ({
        bucket: `upload:${PEOPLE.active.id}`,
        at: Date.now(),
      })),
    );
    expect(
      (
        await harness.send(root, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(input()),
        })
      ).status,
    ).toBe(429);
    await reserve({ purpose: 'avatar', width: 512, height: 512, thumbBytes: 0 });
  });

  it('AC-MEM-11 foreign owner, expired and terminal PUTs preserve both staging and final bytes', async () => {
    const reservation = await uploaded();
    const row = (await findReservation(database, reservation.id))!;
    const before = await usage();
    const admin = await harness.as(PEOPLE.admin.email);
    expect((await put(row.id, 'image', webp, admin)).status).toBe(403);
    expect((await finish(row.id, {}, admin)).status).toBe(403);
    expect((await abandon(row.id, admin)).status).toBe(403);
    expect(await usage()).toEqual(before);
    expect(
      new Uint8Array(await new Response((await storage.get(row.objectKey))!.body).arrayBuffer()),
    ).toEqual(webp);
    await database.db
      .update(uploadReservations)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(uploadReservations.id, row.id));
    expect((await put(row.id)).status).toBe(409);
    expect((await finish(row.id)).status).toBe(409);
    expect(await usage()).toEqual(before);
    await database.db
      .update(uploadReservations)
      .set({ expiresAt: Date.now() + 60000 })
      .where(eq(uploadReservations.id, row.id));
    expect((await finish(row.id)).status).toBe(201);
    await storage.put(row.objectKey, stream(webp), {
      contentType: 'image/webp',
      maxBytes: webp.length,
    });
    const after = await usage();
    const beforeKeys = await keys();
    for (const state of ['completed', 'released'] as const) {
      await database.db
        .update(uploadReservations)
        .set({ state })
        .where(eq(uploadReservations.id, row.id));
      expect((await put(row.id)).status).toBe(409);
      expect(await keys()).toEqual(beforeKeys);
      expect(
        new Uint8Array(
          await new Response((await storage.get(finalKeys(row).objectKey))!.body).arrayBuffer(),
        ),
      ).toEqual(webp);
      expect(
        new Uint8Array(await new Response((await storage.get(row.objectKey))!.body).arrayBuffer()),
      ).toEqual(webp);
      expect(await usage()).toEqual(after);
    }
  });

  it('AC-MEM-04 complete rehashes staged objects and removes corrupt staging and copied final objects', async () => {
    const reservation = await uploaded();
    const row = (await findReservation(database, reservation.id))!;
    const changed = webp.slice();
    changed[15] = 99;
    await storage.put(row.thumbKey, stream(changed), {
      contentType: 'image/webp',
      maxBytes: changed.length,
    });
    const before = await usage();
    expect((await finish(row.id)).status).toBe(400);
    // Open reservations retain copied finals until reconcile can safely remove them.
    expect(await keys()).toEqual(Object.values(finalKeys(row)).sort());
    expect(await usage()).toEqual(before);
    expect(await database.db.select().from(media).limit(1)).toEqual([]);
  });

  it('AC-MEM-12 a failed duplicate complete preserves copied final objects while the winner is open', async () => {
    const reservation = await uploaded();
    const row = (await findReservation(database, reservation.id))!;
    const final = finalKeys(row);
    let resume!: () => void;
    let copied!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      copied = resolve;
    });
    const original = storage.put.bind(storage);
    vi.spyOn(storage, 'put').mockImplementation(async (key, body, options) => {
      const result = await original(key, body, options);
      if (key === final.objectKey) {
        copied();
        await gate;
      }
      return result;
    });
    const winner = finish(row.id);
    await ready;
    vi.spyOn(storage, 'head').mockRejectedValueOnce(new Error('synthetic duplicate failure'));
    expect((await finish(row.id)).status).toBe(503);
    expect((await findReservation(database, row.id))!.state).toBe('open');
    expect(await storage.head(final.objectKey)).not.toBeNull();
    resume();
    expect((await winner).status).toBe(201);
    expect(await keys()).toEqual(Object.values(final).sort());
    expect(await usage()).toEqual({ reserved: 0, committed: 32 });
  });

  it('AC-MEM-05 R-MEM-06 accepts independently capped image and thumb declarations', async () => {
    await reserve({
      imageBytes: siteConfig.uploads.maxImageBytes,
      thumbBytes: siteConfig.uploads.maxImageBytes,
    });
    expect(await usage()).toEqual({ reserved: siteConfig.uploads.maxImageBytes * 2, committed: 0 });
  });

  it('AC-MEM-12 duplicate complete and DELETE move bytes once and persist metadata and reserved dimensions', async () => {
    const albumId = uuidv7();
    await database.db
      .insert(albums)
      .values({ id: albumId, name: 'Reunion', yearTag: 2007, createdBy: PEOPLE.active.id });
    const reservation = await uploaded();
    const completed = await Promise.all([
      finish(reservation.id, { caption: 'Synthetic photo', albumId, takenYear: 2006 }),
      finish(reservation.id, { caption: 'Synthetic photo', albumId, takenYear: 2006 }),
    ]);
    expect(completed.map((response) => response.status).sort()).toEqual([201, 409]);
    const rows = await database.db.select().from(media).limit(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      width: 1600,
      height: 1200,
      caption: 'Synthetic photo',
      albumId,
      takenYear: 2006,
      effectiveYear: 2007,
    });
    expect(await usage()).toEqual({ reserved: 0, committed: 32 });
    expect((await abandon(reservation.id)).status).toBe(200);
    expect((await abandon(reservation.id)).status).toBe(200);
    expect(await usage()).toEqual({ reserved: 0, committed: 32 });
    expect(await keys()).toHaveLength(2);
    const second = await uploaded();
    expect((await abandon(second.id)).status).toBe(200);
    expect((await abandon(second.id)).status).toBe(200);
    expect(await usage()).toEqual({ reserved: 0, committed: 32 });
    expect(await keys()).toHaveLength(2);
    await reserve();
  });

  it('AC-MEM-12 complete racing a release cannot double-count or leave final objects', async () => {
    const reservation = await uploaded();
    const row = (await findReservation(database, reservation.id))!;
    const [response] = await Promise.all([finish(row.id), abandon(row.id)]);
    const completed = response.status === 201;
    expect([201, 400, 409]).toContain(response.status);
    expect(await usage()).toEqual({ reserved: 0, committed: completed ? 32 : 0 });
    expect(await keys()).toHaveLength(completed ? 2 : 0);
  });

  it.each([webp, jpeg])(
    'AC-MEM-10 streams allowed media with private headers; ETag 304 never calls storage',
    async (data) => {
      const reservation = await uploaded({}, data);
      expect((await finish(reservation.id)).status).toBe(201);
      for (const variant of ['image', 'thumb']) {
        const path = `/api/v1/media/${reservation.mediaId}/${variant}`;
        const response = await harness.send(path, { headers: auth });
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe(
          variant === 'thumb' ? 'private, max-age=300' : 'private, no-cache',
        );
        expect(response.headers.get('content-type')).toBe(input(data).mimeType);
        expect(response.headers.get('content-disposition')).toBe('inline');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('etag')).toBe(`"${digest(data)}"`);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
        const read = vi.spyOn(storage, 'get');
        const head = vi.spyOn(storage, 'head');
        const cached = await harness.send(path, {
          headers: { ...auth, 'if-none-match': `"other", W/"${digest(data)}"` },
        });
        expect(cached.status).toBe(304);
        expect(await cached.text()).toBe('');
        expect(read).not.toHaveBeenCalled();
        expect(head).not.toHaveBeenCalled();
        read.mockRestore();
        head.mockRestore();
      }
    },
  );

  it('AC-MEM-07 media URLs deny absent or suspended identity and deleted media disappear immediately', async () => {
    const reservation = await uploaded();
    expect((await finish(reservation.id)).status).toBe(201);
    const path = `/api/v1/media/${reservation.mediaId}/image`;
    const suspended = await harness.as(PEOPLE.suspended.email);
    const read = vi.spyOn(storage, 'get');
    expect((await harness.send(path)).status).toBe(403);
    expect((await harness.send(path, { headers: suspended })).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    await database.db
      .update(media)
      .set({ deletedAt: Date.now() })
      .where(eq(media.id, reservation.mediaId));
    expect((await harness.send(path, { headers: auth })).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(await usage()).toEqual({ reserved: 0, committed: 32 });
    expect(await keys()).toHaveLength(2);
  });
});
