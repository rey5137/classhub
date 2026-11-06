import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../src/lib/i18n';
import { siteConfig } from '../../src/lib/config';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import {
  albums,
  media,
  r2Operations,
  rateEvents,
  storageUsage,
  uploadReservations,
  profileContacts,
  siteSettings,
  users,
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import { finalKeys, findReservation } from '../../src/lib/server/repositories/media';
import { readOperations } from '../../src/lib/server/repositories/operations';
import { CLASS_B_FLUSH_MS, monthKey } from '../../src/lib/server/services/operations';
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
    // R-MEM-16: the bytes are served only while it is the owner's current avatar.
    const hidden = await harness.send(`/api/v1/media/${avatar.mediaId}/image`, { headers: auth });
    expect(hidden.status).toBe(404);
    await database.db
      .update(users)
      .set({ avatarMediaId: avatar.mediaId })
      .where(eq(users.id, PEOPLE.active.id));
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

describe('avatar bytes and upload refusals', () => {
  const avatarOverrides = {
    purpose: 'avatar',
    width: 512,
    height: 512,
    thumbBytes: 0,
    thumbSha256: digest(new Uint8Array()),
  };
  async function currentAvatar() {
    const reservation = await uploaded(avatarOverrides);
    expect((await finish(reservation.id)).status).toBe(201);
    await database.db
      .update(users)
      .set({ avatarMediaId: reservation.mediaId, status: 'active' })
      .where(eq(users.id, PEOPLE.active.id));
    await database.db.delete(profileContacts).where(eq(profileContacts.userId, PEOPLE.active.id));
    return `/api/v1/media/${reservation.mediaId}/image`;
  }
  const setVisibility = (value: string) =>
    database.db
      .insert(profileContacts)
      .values({
        userId: PEOPLE.active.id,
        visibilityJson: JSON.stringify({ avatar_media_id: value }),
      })
      .onConflictDoUpdate({
        target: profileContacts.userId,
        set: { visibilityJson: JSON.stringify({ avatar_media_id: value }) },
      });
  // Admin and the owner are two members; a third viewer is the suspended one's counterpart.
  const viewer = () => harness.as(PEOPLE.admin.email);

  afterEach(async () => {
    await database.db
      .update(users)
      .set({ avatarMediaId: null, status: 'active' })
      .where(eq(users.id, PEOPLE.active.id));
    await database.db
      .update(users)
      .set({ status: 'suspended' })
      .where(eq(users.id, PEOPLE.suspended.id));
    await database.db.delete(profileContacts);
  });

  it('AC-MEM-07 AC-PROF-01 an avatar is served to the owner and, by visibility, to other members', async () => {
    const path = await currentAvatar();
    const member = await harness.as(PEOPLE.admin.email);
    expect((await harness.send(path, { headers: auth })).status).toBe(200);
    expect((await harness.send(path, { headers: member })).status).toBe(200);
    await setVisibility('private');
    expect((await harness.send(path, { headers: auth })).status).toBe(200);
    expect((await harness.send(path, { headers: member })).status).toBe(404);
    await setVisibility('admins');
    expect((await harness.send(path, { headers: member })).status).toBe(200);
  });

  it('AC-MEM-07 AC-PROF-01 a member viewer is refused an admins-only avatar, an admin is not', async () => {
    const path = await currentAvatar();
    // The owner of the avatar is the admin here, so `active` is the plain member viewer.
    const mediaId = path.split('/')[4]!;
    await database.db
      .update(users)
      .set({ avatarMediaId: null })
      .where(eq(users.id, PEOPLE.active.id));
    await database.db.update(media).set({ ownerId: PEOPLE.admin.id }).where(eq(media.id, mediaId));
    await database.db
      .update(users)
      .set({ avatarMediaId: mediaId })
      .where(eq(users.id, PEOPLE.admin.id));
    await database.db.insert(profileContacts).values({
      userId: PEOPLE.admin.id,
      visibilityJson: JSON.stringify({ avatar_media_id: 'admins' }),
    });
    expect((await harness.send(path, { headers: auth })).status).toBe(404);
    expect((await harness.send(path, { headers: await viewer() })).status).toBe(200);
    await database.db
      .update(users)
      .set({ avatarMediaId: null })
      .where(eq(users.id, PEOPLE.admin.id));
  });

  it('AC-MEM-07 AC-PROF-01 a suspended owner, a replaced avatar and a hidden avatar on the 304 path get 404', async () => {
    const path = await currentAvatar();
    const member = await viewer();
    const etag = (await harness.send(path, { headers: member })).headers.get('etag')!;
    const revalidate = () => harness.send(path, { headers: { ...member, 'if-none-match': etag } });
    expect((await revalidate()).status).toBe(304);
    await database.db
      .update(users)
      .set({ status: 'suspended' })
      .where(eq(users.id, PEOPLE.active.id));
    expect((await harness.send(path, { headers: member })).status).toBe(404);
    expect((await revalidate()).status).toBe(404);
    await database.db.update(users).set({ status: 'active' }).where(eq(users.id, PEOPLE.active.id));
    expect((await revalidate()).status).toBe(304);
    await setVisibility('private');
    expect((await revalidate()).status).toBe(404);
    await database.db.delete(profileContacts);
    await database.db
      .update(users)
      .set({ avatarMediaId: null })
      .where(eq(users.id, PEOPLE.active.id));
    expect((await harness.send(path, { headers: auth })).status).toBe(404);
  });

  it('AC-MEM-07 a soft-deleted (retired) avatar disappears even for its owner', async () => {
    const path = await currentAvatar();
    await database.db
      .update(media)
      .set({ deletedAt: Date.now() })
      .where(eq(media.id, path.split('/')[4]!));
    expect((await harness.send(path, { headers: auth })).status).toBe(404);
  });

  it('R-MEM-13 a refusal says which limit it hit, and a concurrent one frees at the soonest expiry', async () => {
    const send = () =>
      harness.send(root, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input()) });
    const first = await reserve();
    await reserve();
    const [early] = await database.db
      .select({ at: uploadReservations.expiresAt })
      .from(uploadReservations)
      .where(eq(uploadReservations.id, first.id));
    await database.db
      .update(uploadReservations)
      .set({ expiresAt: Date.now() + 90_000 })
      .where(eq(uploadReservations.id, first.id));
    expect(early!.at).toBeGreaterThan(Date.now() + 90_000);
    // Both limits are hit (25 events and two open reservations): concurrent is reported.
    await database.db.insert(rateEvents).values(
      Array.from({ length: 25 }, () => ({
        bucket: `upload:${PEOPLE.active.id}`,
        at: Date.now(),
      })),
    );
    const both = await send();
    expect(both.status).toBe(429);
    const bothBody = errorBodySchema.parse(await both.json());
    expect(bothBody.error.reason).toBe('concurrent');
    expect(bothBody.error.message).toBe(t('en', 'upload.error.rate_limited_concurrent'));
    const wait = Number(both.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(80);
    expect(wait).toBeLessThanOrEqual(90);
    await abandon(first.id);
    await abandon((await database.db.select().from(uploadReservations).limit(1))[0]!.id);
    const daily = await send();
    expect(errorBodySchema.parse(await daily.json()).error.reason).toBe('daily');
    expect(daily.headers.get('retry-after')).toBe('900');
  });

  it('R-MEM-13 a concurrent refusal waits at least one second and at most 900', async () => {
    const send = () =>
      harness.send(root, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input()) });
    const first = await reserve();
    await reserve();
    await database.db
      .update(uploadReservations)
      .set({ expiresAt: Date.now() + 200 })
      .where(eq(uploadReservations.id, first.id));
    expect(Number((await send()).headers.get('retry-after'))).toBe(1);
  });

  it('R-MEM-13 an avatar over 1 MB is refused at the reservation; 1 MB is accepted', async () => {
    const response = await harness.send(root, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...input(), ...avatarOverrides, imageBytes: 1_048_577 }),
    });
    expect(response.status).toBe(400);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('validation');
    await reserve({ ...avatarOverrides, imageBytes: 1_048_576 });
  });
});

describe('R-MEM-18 R2 operation estimate', () => {
  it('R-MEM-18 an upload counts its four PUTs as Class A, exactly, and its staging deletes as nothing', async () => {
    const reservation = await reserve();
    await harness.settleHousekeeping();
    const month = monthKey(Date.now());
    const before = await readOperations(database, month);
    expect((await put(reservation.id, 'image')).status).toBe(200);
    expect((await put(reservation.id, 'thumb')).status).toBe(200);
    expect((await finish(reservation.id)).status).toBe(201);
    await harness.settleHousekeeping();
    const after = await readOperations(database, month);
    // Two staging PUTs and two final PUTs; the staging deletes are not billed.
    expect(after.classA - before.classA).toBe(4);
  });

  it('R-MEM-18 a refused PUT still counts the PUT but not its cleanup delete', async () => {
    const reservation = await reserve({ sha256: '0'.repeat(64) });
    await harness.settleHousekeeping();
    const month = monthKey(Date.now());
    const before = await readOperations(database, month);
    expect((await put(reservation.id, 'image')).status).toBe(400);
    await harness.settleHousekeeping();
    expect((await readOperations(database, month)).classA - before.classA).toBe(1);
  });

  it('R-MEM-18 a media GET counts one Class B read and a 304 counts none, flushed after a minute', async () => {
    const reservation = await uploaded();
    expect((await finish(reservation.id)).status).toBe(201);
    // A month of its own, so only this clock's requests land in it.
    let clock = 1_900_000_000_000;
    const timed = await createHarness(database, {
      storage,
      resolve: resolveMediaRoute,
      now: () => clock,
    });
    const headers = await timed.as(PEOPLE.active.email);
    const month = monthKey(clock);
    // Earlier tests' reads sit in this isolate's tally; a request that reads nothing
    // flushes them (their minute is long up), so the hold below starts empty.
    expect((await timed.send(`/api/v1/media/${uuidv7()}/thumb`, { headers })).status).toBe(404);
    await timed.settleHousekeeping();
    const path = `/api/v1/media/${reservation.mediaId}/thumb`;
    const fetched = await timed.send(path, { headers });
    expect(fetched.status).toBe(200);
    // Held for a minute: nothing is written yet.
    await timed.settleHousekeeping();
    expect((await readOperations(database, month)).classB).toBe(0);
    const etag = fetched.headers.get('etag')!;
    clock += 1;
    const cached = await timed.send(path, { headers: { ...headers, 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    clock += CLASS_B_FLUSH_MS + 1;
    // Any later request carries the isolate's tally once its minute is up.
    expect((await timed.send(`/api/v1/media/${uuidv7()}/thumb`, { headers })).status).toBe(404);
    await timed.settleHousekeeping();
    expect((await readOperations(database, month)).classB).toBe(1);
    await database.db.delete(r2Operations).where(eq(r2Operations.month, month));
  });
});

describe('R-NAV-02 memories turned off', () => {
  const memoriesOff = () =>
    database.db
      .insert(siteSettings)
      .values({
        key: 'features',
        valueJson: JSON.stringify({ ...siteConfig.features, memories: false }),
      })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { valueJson: JSON.stringify({ ...siteConfig.features, memories: false }) },
      });
  afterEach(async () => {
    await database.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
    await database.db
      .update(users)
      .set({ avatarMediaId: null })
      .where(eq(users.id, PEOPLE.active.id));
  });

  it('AC-NAV-04 refuses a photo upload, hides photo bytes like an unknown id; avatars and site media stay served', async () => {
    const photo = await uploaded();
    expect((await finish(photo.id)).status).toBe(201);
    await memoriesOff();

    const refused = await harness.send(root, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(input()),
    });
    expect(refused.status).toBe(404);
    expect(errorBodySchema.parse(await refused.json()).error.code).toBe('feature_disabled');
    // A photo answers like an unknown id, so which ids are photos can't be probed.
    const bytes = await harness.send(`/api/v1/media/${photo.mediaId}/image`, { headers: auth });
    const unknown = await harness.send(`/api/v1/media/${uuidv7()}/image`, { headers: auth });
    expect(errorBodySchema.parse(await bytes.json()).error.code).toBe('not_found');
    expect(bytes.status).toBe(unknown.status);

    const avatar = await uploaded({
      purpose: 'avatar',
      width: 512,
      height: 512,
      thumbBytes: 0,
      thumbSha256: digest(new Uint8Array()),
    });
    expect((await finish(avatar.id)).status).toBe(201);
    await database.db
      .update(users)
      .set({ avatarMediaId: avatar.mediaId })
      .where(eq(users.id, PEOPLE.active.id));
    expect(
      (await harness.send(`/api/v1/media/${avatar.mediaId}/image`, { headers: auth })).status,
    ).toBe(200);
    const admin = await harness.as(PEOPLE.admin.email);
    const site = await harness.send(root, {
      method: 'POST',
      headers: { ...admin, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input(), purpose: 'site' }),
    });
    expect(site.status).toBe(201);

    // Turned back on, the same photo is served again.
    await database.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
    expect(
      (await harness.send(`/api/v1/media/${photo.mediaId}/image`, { headers: auth })).status,
    ).toBe(200);
  });
});
