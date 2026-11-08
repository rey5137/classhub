import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../../src/lib/config';
import { albumPageSchema, galleryPageSchema } from '../../src/lib/contracts/media';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import type { Member } from '../../src/lib/server/auth/membership';
import type { AppContext } from '../../src/lib/server/context';
import { DEFAULT_VISIBILITY } from '../../src/lib/contracts/profile';
import {
  albums,
  media,
  profileContacts,
  storageUsage,
  users,
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import { JobRunner } from '../../src/lib/server/services/job-runner';
import { defaultSettings } from '../../src/lib/server/services/settings';
import { load as layoutLoad } from '../../src/routes/+layout.server';
import {
  actions as photoActions,
  load as photoLoad,
} from '../../src/routes/memories/[id]/+page.server';
import { seedDeletedMedia, usage } from '../fixtures/housekeeping';
import { resolveMediaRoute } from '../fixtures/media-routes';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { comparable, createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

let database: Database;
let storage: R2ObjectStorage;
let harness: Harness;
let member: Record<string, string>;
let admin: Record<string, string>;
let other: Record<string, string>;
const OTHER = { id: '01900000-0000-7000-8000-000000000009', email: 'other.member@example.test' };
const BASE = 1_800_000_000_000;

const send = (path: string, method = 'GET', headers = member, body?: unknown) =>
  harness.send(path, {
    method,
    headers: {
      ...headers,
      ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
async function page(query = '', headers = member) {
  const response = await send(`/api/v1/media${query}`, 'GET', headers);
  expect(response.status).toBe(200);
  return galleryPageSchema.parse(await response.json());
}
async function photo(overrides: Partial<typeof media.$inferInsert> = {}) {
  return seedDeletedMedia(database, { deletedAt: null, createdAt: BASE, ...overrides });
}
async function album(overrides: Partial<typeof albums.$inferInsert> = {}) {
  const row = {
    id: uuidv7(),
    name: 'Trại hè',
    createdBy: PEOPLE.active.id,
    createdAt: BASE,
    ...overrides,
  };
  await database.db.insert(albums).values(row);
  return row;
}
async function year(id: string) {
  const [row] = await database.db
    .select({ year: media.effectiveYear })
    .from(media)
    .where(eq(media.id, id));
  return row!.year;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  storage = new R2ObjectStorage(
    env.MEDIA as unknown as ConstructorParameters<typeof R2ObjectStorage>[0],
  );
  await seedMembership(database);
  await database.db.insert(users).values({
    id: OTHER.id,
    authEmail: OTHER.email,
    displayName: 'Other Member',
    displayNameNorm: 'other member',
    status: 'active',
    role: 'member',
  });
  harness = await createHarness(database, { storage, resolve: resolveMediaRoute });
  member = await harness.as(PEOPLE.active.email);
  admin = await harness.as(PEOPLE.admin.email);
  other = await harness.as(OTHER.email);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await storage.delete((await storage.list('')).objects.map((row) => row.key));
  await database.db.delete(media);
  await database.db.delete(albums);
  await database.db.update(storageUsage).set({ committedBytes: 0, reservedBytes: 0 });
});

describe('gallery listing (R-MEM-14, R-DB-07)', () => {
  it('AC-MEM-03 pages 30 live photos newest first and returns every photo exactly once', async () => {
    // Equal timestamps force the id half of the keyset to break ties.
    for (let index = 0; index < 65; index++) await photo({ createdAt: BASE + (index % 7) });
    await photo({ deletedAt: BASE });
    await photo({ mediaType: 'avatar', createdAt: BASE + 100 });
    const seen: string[] = [];
    let cursor: string | null = '';
    const sizes: number[] = [];
    while (cursor !== null) {
      const result = await page(cursor ? `?cursor=${cursor}` : '');
      sizes.push(result.items.length);
      seen.push(...result.items.map((item) => `${item.createdAt}:${item.id}`));
      cursor = result.nextCursor;
    }
    expect(sizes).toEqual([30, 30, 5]);
    expect(new Set(seen).size).toBe(65);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it('AC-MEM-03 filters by album and by effective year, and shows the uploader by display name only', async () => {
    const camp = await album({ yearTag: 2005 });
    const inCamp = await photo({ albumId: camp.id, effectiveYear: 2005, caption: 'Đốt lửa trại' });
    const loose = await photo({ effectiveYear: 2006, ownerId: PEOPLE.admin.id });
    const byAlbum = await page(`?album=${camp.id}`);
    expect(byAlbum.items.map((item) => item.id)).toEqual([inCamp.id]);
    expect(byAlbum.items[0]).toMatchObject({
      caption: 'Đốt lửa trại',
      album: { id: camp.id, name: 'Trại hè' },
      year: 2005,
      uploader: { id: PEOPLE.active.id, displayName: 'Active Member' },
      canEdit: true,
    });
    expect(JSON.stringify(byAlbum)).not.toContain('@example.test');
    expect((await page('?year=2006')).items.map((item) => item.id)).toEqual([loose.id]);
    expect((await page('?year=2006')).items[0]!.canEdit).toBe(false);
    expect((await page(`?album=${camp.id}&year=2006`)).items).toEqual([]);
  });

  it('AC-MEM-03 refuses a cursor or filter the server did not write', async () => {
    for (const query of ['?cursor=bm90LWpzb24', '?year=05', '?album=nope', '?extra=1']) {
      expect((await send(`/api/v1/media${query}`)).status).toBe(400);
    }
  });
});

describe('albums (R-MEM-14, §3.3)', () => {
  it('AC-MEM-03 a member creates an album; only its creator or an admin edits it', async () => {
    const created = await send('/api/v1/albums', 'POST', member, {
      name: '  Lớp 12A  ',
      yearTag: 2007,
      description: 'Năm cuối',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string };
    expect(body.name).toBe('Lớp 12A');
    for (const invalid of [{ name: '' }, { name: 'x'.repeat(81) }, { name: 'a', yearTag: 99 }])
      expect((await send('/api/v1/albums', 'POST', member, invalid)).status).toBe(400);

    const path = `/api/v1/albums/${body.id}`;
    const denied = await send(path, 'PATCH', other, { name: 'Đổi tên' });
    const unknown = await send(`/api/v1/albums/${uuidv7()}`, 'PATCH', other, { name: 'x' });
    expect(denied.status).toBe(403);
    expect(await comparable(unknown)).toEqual(await comparable(denied));
    expect((await send(path, 'PATCH', member, { name: 'Lớp 12A1' })).status).toBe(200);
    expect((await send(path, 'PATCH', admin, { description: null })).status).toBe(200);
    const listed = await send('/api/v1/albums', 'GET', other);
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([
      { id: body.id, name: 'Lớp 12A1', yearTag: 2007, description: null, canEdit: false },
    ]);
  });

  it('AC-MEM-03 a new year tag rewrites every photo of the album; a cleared tag falls back to taken_year', async () => {
    const camp = await album({ yearTag: 2005 });
    const tagged = await photo({ albumId: camp.id, effectiveYear: 2005, takenYear: 2004 });
    const untaken = await photo({ albumId: camp.id, effectiveYear: 2005 });
    const outside = await photo({ effectiveYear: 2003, takenYear: 2003 });
    const batch = vi.spyOn(database, 'batch');
    expect(
      (await send(`/api/v1/albums/${camp.id}`, 'PATCH', member, { yearTag: 2006 })).status,
    ).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
    expect([await year(tagged.id), await year(untaken.id), await year(outside.id)]).toEqual([
      2006, 2006, 2003,
    ]);
    expect((await page('?year=2006')).items).toHaveLength(2);
    await send(`/api/v1/albums/${camp.id}`, 'PATCH', admin, { yearTag: null });
    expect([await year(tagged.id), await year(untaken.id)]).toEqual([2004, null]);
  });

  it('AC-MEM-03 a big album is rewritten in chunks of at most 500 and a retry finishes an interrupted rewrite (R-BUD-08)', async () => {
    const camp = await album({ yearTag: 2005 });
    // 1,201 live photos plus one deleted one, seeded in a single statement.
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 1202)
       insert into media (id, owner_id, media_type, album_id, object_key, thumb_key, mime_type,
         width, height, size_bytes, thumb_size_bytes, sha256, thumb_sha256, effective_year,
         created_at, deleted_at)
       select printf('01900000-0000-7000-8000-%012d', i), ?, 'photo', ?,
         printf('media/v1/%d/image.webp', i), printf('media/v1/%d/thumb.webp', i), 'image/webp',
         1, 1, 12, 8, ?, ?, 2005, ?, case when i = 1202 then ? end from n`,
    )
      .bind(PEOPLE.active.id, camp.id, 'a'.repeat(64), 'b'.repeat(64), BASE, BASE)
      .run();
    const counts = async () =>
      (
        await env.DB.prepare(
          'select effective_year as year, count(*) as n from media group by effective_year order by year',
        ).all<{ year: number; n: number }>()
      ).results;
    const real = database.batch.bind(database);
    // The second chunk fails: the album row and the first 500 photos are already written.
    let calls = 0;
    const batch = vi.spyOn(database, 'batch').mockImplementation(async (queries) => {
      calls += 1;
      if (calls === 2) throw new Error('D1 unavailable');
      return real(queries);
    });
    expect(
      (await send(`/api/v1/albums/${camp.id}`, 'PATCH', member, { yearTag: 2006 })).status,
    ).toBe(503);
    expect(await counts()).toEqual([
      { year: 2005, n: 702 },
      { year: 2006, n: 500 },
    ]);
    batch.mockRestore();
    const resumed = vi.spyOn(database, 'batch');
    expect(
      (await send(`/api/v1/albums/${camp.id}`, 'PATCH', member, { yearTag: 2006 })).status,
    ).toBe(200);
    // Only the 701 still-stale live rows: 500, then 201, and nothing touches the deleted one.
    const changes = await Promise.all(
      resumed.mock.results.map(async (result) => (await result.value) as { changes: number }[]),
    );
    expect(changes.map((rows) => rows.at(-1)!.changes)).toEqual([500, 201]);
    expect(await counts()).toEqual([
      { year: 2005, n: 1 },
      { year: 2006, n: 1201 },
    ]);
  });
});

describe('photo edit and delete (R-MEM-14, R-MEM-20, §3.3)', () => {
  it('AC-MEM-03 the owner or an admin edits caption and album; a move recomputes effective_year', async () => {
    const camp = await album({ yearTag: 2005 });
    const row = await photo({ takenYear: 2002, effectiveYear: 2002 });
    const path = `/api/v1/media/${row.id}`;
    expect(
      (await send(path, 'PATCH', member, { caption: 'Sân trường', albumId: camp.id })).status,
    ).toBe(200);
    expect(await year(row.id)).toBe(2005);
    expect((await send(path, 'PATCH', admin, { albumId: null })).status).toBe(200);
    expect(await year(row.id)).toBe(2002);
    const [stored] = await database.db.select().from(media).where(eq(media.id, row.id));
    expect(stored).toMatchObject({ caption: 'Sân trường', albumId: null });
    expect((await send(path, 'PATCH', member, { albumId: uuidv7() })).status).toBe(400);
    expect((await send(path, 'PATCH', member, { caption: 'x'.repeat(501) })).status).toBe(400);
    expect((await send(path, 'PATCH', member, {})).status).toBe(400);
  });

  it('AC-MEM-03 another member, an unknown id, a deleted photo and an avatar get one identical denial', async () => {
    const row = await photo();
    const gone = await photo({ deletedAt: BASE });
    const avatar = await photo({ mediaType: 'avatar' });
    for (const method of ['PATCH', 'DELETE']) {
      const body = method === 'PATCH' ? { caption: 'x' } : undefined;
      const answers = [
        await send(`/api/v1/media/${row.id}`, method, other, body),
        await send(`/api/v1/media/${uuidv7()}`, method, member, body),
        await send(`/api/v1/media/${gone.id}`, method, member, body),
        await send(`/api/v1/media/${avatar.id}`, method, member, body),
        await send('/api/v1/media/not-a-uuid', method, member, body),
      ];
      expect(answers[0]!.status).toBe(403);
      const first = await comparable(answers[0]!);
      for (const answer of answers.slice(1)) expect(await comparable(answer)).toEqual(first);
    }
    const [stored] = await database.db.select().from(media).where(eq(media.id, row.id));
    expect(stored).toMatchObject({ caption: null, deletedAt: null });
  });

  it('AC-MEM-03 a deleted photo leaves the gallery and its URLs at once; its bytes go only at purge', async () => {
    const row = await photo({ sizeBytes: 12, thumbSizeBytes: 8 });
    for (const key of [row.objectKey, row.thumbKey]) {
      await storage.put(key, new Blob([new Uint8Array(4)]).stream() as ReadableStream<Uint8Array>, {
        contentType: 'image/webp',
        maxBytes: 4,
      });
    }
    expect((await send(`/api/v1/media/${row.id}/thumb`)).status).toBe(200);
    const removed = await send(`/api/v1/media/${row.id}`, 'DELETE', member);
    expect(removed.status).toBe(200);
    expect((await page()).items).toEqual([]);
    expect((await send(`/api/v1/media/${row.id}/image`)).status).toBe(404);
    expect((await usage(database)).committedBytes).toBe(20);
    // A repeated delete is the uniform denial and changes nothing.
    const [before] = await database.db.select().from(media).where(eq(media.id, row.id));
    expect((await send(`/api/v1/media/${row.id}`, 'DELETE', admin)).status).toBe(403);
    const [after] = await database.db.select().from(media).where(eq(media.id, row.id));
    expect(after).toEqual(before);

    const runner = new JobRunner({ database, storage });
    const graceEnds = before!.deletedAt! + siteConfig.deletedMediaGraceDays * 86_400_000;
    await runner.run(graceEnds - 1);
    expect((await usage(database)).committedBytes).toBe(20);
    await runner.run(graceEnds + 1);
    await runner.run(graceEnds + 2);
    expect((await usage(database)).committedBytes).toBe(0);
    expect((await storage.list('media/')).objects).toEqual([]);
  });

  it('AC-MEM-03 an admin deletes anyone’s photo', async () => {
    const row = await photo();
    expect((await send(`/api/v1/media/${row.id}`, 'DELETE', admin)).status).toBe(200);
    expect((await page()).items).toEqual([]);
  });
});

describe('uploader projection (R-PROF-02, INV-5)', () => {
  const photoPage = (person: Member, id: string) =>
    photoLoad({
      locals: {
        member: person,
        context: { database } as unknown as AppContext,
        locale: 'vi',
        settings: defaultSettings,
      },
      params: { id },
    } as unknown as Parameters<typeof photoLoad>[0]) as Promise<{
      photo: { uploader: { avatarMediaId?: string } };
    }>;
  const asMember = { id: PEOPLE.active.id, role: 'member' } as Member;
  const asAdmin = { id: PEOPLE.admin.id, role: 'admin' } as Member;

  it('AC-MEM-03 an uploader’s avatar follows their saved visibility on the wall and the photo page', async () => {
    const avatar = uuidv7();
    await database.db.update(users).set({ avatarMediaId: avatar }).where(eq(users.id, OTHER.id));
    const row = await photo({ ownerId: OTHER.id });
    const seen = async (headers: Record<string, string>, person: Member) => [
      (await page('', headers)).items[0]!.uploader.avatarMediaId,
      (await photoPage(person, row.id)).photo.uploader.avatarMediaId,
    ];
    try {
      // No contacts row yet: the default map shows the avatar to members.
      expect(await seen(member, asMember)).toEqual([avatar, avatar]);
      const save = (avatarVisibility: string) =>
        database.db
          .insert(profileContacts)
          .values({
            userId: OTHER.id,
            visibilityJson: JSON.stringify({
              ...DEFAULT_VISIBILITY,
              avatar_media_id: avatarVisibility,
            }),
          })
          .onConflictDoUpdate({
            target: profileContacts.userId,
            set: {
              visibilityJson: JSON.stringify({
                ...DEFAULT_VISIBILITY,
                avatar_media_id: avatarVisibility,
              }),
            },
          });
      await save('private');
      expect(await seen(member, asMember)).toEqual([undefined, undefined]);
      expect(await seen(admin, asAdmin)).toEqual([undefined, undefined]);
      await save('admins');
      expect(await seen(member, asMember)).toEqual([undefined, undefined]);
      expect(await seen(admin, asAdmin)).toEqual([avatar, avatar]);
    } finally {
      await database.db.delete(profileContacts).where(eq(profileContacts.userId, OTHER.id));
      await database.db.update(users).set({ avatarMediaId: null }).where(eq(users.id, OTHER.id));
    }
  });
});

describe('photo page edit form (R-MEM-14)', () => {
  const owner = { id: PEOPLE.active.id, role: 'member' } as Member;

  it('AC-MEM-03 a caption-only save keeps an album that sorts past the 200 the select lists', async () => {
    const locals = {
      member: owner,
      context: { database } as unknown as AppContext,
      locale: 'vi',
      settings: defaultSettings,
    };
    // 200 albums named before it (including 80-char Vietnamese names whose cursors exceed 200 chars).
    const vnPad = 'Kỷ niệm trường xưa thân yêu mãi nhớ về thầy cô bạn bè dưới mái trường '.slice(
      0,
      74,
    );
    for (let start = 0; start < 200; start += 20) {
      await database.db.insert(albums).values(
        Array.from({ length: 20 }, (_, index) => ({
          id: uuidv7(),
          name: `A ${String(start + index).padStart(3, '0')} ${vnPad}`.slice(0, 80),
          createdBy: PEOPLE.active.id,
          createdAt: BASE,
        })),
      );
    }
    const last = await album({ name: 'Z cuối', yearTag: 2001 });
    const row = await photo({ albumId: last.id, effectiveYear: 2001 });
    const loaded = (await photoLoad({ locals, params: { id: row.id } } as unknown as Parameters<
      typeof photoLoad
    >[0])) as { albums: { id: string }[]; albumsNextCursor: string | null };
    expect(loaded.albums.map((entry) => entry.id)).toContain(last.id);
    expect(loaded.albumsNextCursor).toBeTruthy();

    // Keyset-page through all 201 albums via GET /api/v1/albums.
    const seenIds: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await send(
        `/api/v1/albums${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.status).toBe(200);
      const parsed = albumPageSchema.parse(await res.json());
      seenIds.push(...parsed.items.map((item) => item.id));
      cursor = parsed.nextCursor ?? null;
    } while (cursor);
    expect(seenIds).toHaveLength(201);
    expect(seenIds.at(-1)).toBe(last.id);

    const save = async (fields: Record<string, string>) => {
      const body = new FormData();
      for (const [name, value] of Object.entries(fields)) body.set(name, value);
      return photoActions.edit!({
        locals,
        params: { id: row.id },
        request: new Request('https://class.example.test/memories', { method: 'POST', body }),
      } as unknown as Parameters<NonNullable<typeof photoActions.edit>>[0]);
    };
    // What the browser posts with the album still selected, then a form without the field.
    expect(await save({ caption: 'Mới', albumId: last.id })).toEqual({
      action: 'edit',
      done: 'saved',
    });
    expect(await save({ caption: 'Mới hơn' })).toEqual({ action: 'edit', done: 'saved' });
    const [stored] = await database.db
      .select({ albumId: media.albumId, caption: media.caption })
      .from(media)
      .where(eq(media.id, row.id));
    expect(stored).toEqual({ albumId: last.id, caption: 'Mới hơn' });
    expect(await year(row.id)).toBe(2001);
  });
});

describe('storage banner (R-MEM-15)', () => {
  const layout = (person: Member) =>
    layoutLoad({
      locals: {
        member: person,
        context: { database } as unknown as AppContext,
        locale: 'vi',
        theme: 'yearbook',
        mode: 'light',
        settings: defaultSettings,
      },
      url: new URL('https://classhub.example.test/'),
      route: { id: '/' },
    } as unknown as Parameters<typeof layoutLoad>[0]) as Promise<{ storageWarning: boolean }>;
  const asMember = { id: PEOPLE.active.id, role: 'member' } as Member;
  const asAdmin = { id: PEOPLE.admin.id, role: 'admin' } as Member;

  it('AC-MEM-06 admins see the warning at mediaWarnBytes; members never do and cost no read', async () => {
    await database.db
      .update(storageUsage)
      .set({ committedBytes: siteConfig.limits.mediaWarnBytes - 1, reservedBytes: 0 });
    expect((await layout(asAdmin)).storageWarning).toBe(false);
    await database.db.update(storageUsage).set({ reservedBytes: 1 });
    expect((await layout(asAdmin)).storageWarning).toBe(true);
    const read = vi.spyOn(database.db, 'select');
    expect((await layout(asMember)).storageWarning).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
