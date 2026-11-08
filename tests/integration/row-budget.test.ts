import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import { seedChatVolume, seedDemo } from '../../src/lib/server/db/seed-demo';
import {
  albums,
  comments,
  infoPages,
  invites,
  joinRequests,
  media,
  posts,
  users,
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { resolveAppRoute } from '../fixtures/app-routes';
import { countingD1 } from '../fixtures/d1-instrument';
import { createHarness, type Harness } from '../fixtures/pipeline-harness';
import { budgets } from '../fixtures/row-budgets';

// AC-BUD-02, R-BUD-01: one page view of every GET route on the demo seed, with the
// rows D1 reports read for the whole request (the pipeline's own reads included).

let harness: Harness;
let counter: ReturnType<typeof countingD1>;
const ids: Record<string, string> = {};

const MEMBER = 'mai.nguyen@example.com';
const ADMIN = 'admin@example.com';

function path(template: string): string {
  return template.replace(/:([a-z]+)/g, (_, token: string) => {
    const value = ids[token];
    if (!value) throw new Error(`row budget: no demo id for :${token}`);
    return value;
  });
}

let plain: ReturnType<typeof createD1Database>;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const storage = new R2ObjectStorage(
    env.MEDIA as unknown as ConstructorParameters<typeof R2ObjectStorage>[0],
  );
  plain = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedDemo(plain, storage);

  const [member] = await plain.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authEmail, MEMBER))
    .limit(1);
  const [admin] = await plain.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authEmail, ADMIN))
    .limit(1);
  const [post] = await plain.db.select({ id: posts.id }).from(posts).limit(1);
  const [photo] = await plain.db.select({ id: media.id }).from(media).limit(1);
  const [info] = await plain.db
    .select({ slug: infoPages.slug })
    .from(infoPages)
    .where(eq(infoPages.slug, 'reunion'))
    .limit(1);
  Object.assign(ids, {
    member: member?.id,
    admin: admin?.id,
    post: post?.id,
    media: photo?.id,
    info: info?.slug,
  });

  counter = countingD1(env.DB as unknown as Parameters<typeof countingD1>[0]);
  const database: Database = createD1Database(counter.database);
  harness = await createHarness(database, {
    resolve: resolveAppRoute,
    appearance: true,
    storage,
  });

  // The first request settles the hourly housekeeping job and the member's writes, so
  // the measured requests are the page's own work (R-BUD-02).
  await harness.send('/members', { headers: await harness.as(MEMBER) });
  await harness.settleHousekeeping();
  counter.reset();
});

describe('AC-BUD-02 row-read budget on the demo seed', () => {
  it('every GET route stays inside its budget', async () => {
    const measured: { entry: (typeof budgets)[number]; rows: number; status: number }[] = [];
    for (const entry of budgets) {
      counter.reset();
      const email = entry.as === 'admin' ? ADMIN : MEMBER;
      const response = await harness.send(path(entry.path), {
        headers: await harness.as(email),
      });
      await harness.settleHousekeeping();
      const rows = counter.rowsRead();
      await response.body?.cancel();
      measured.push({ entry, rows, status: response.status });
    }
    for (const { entry, rows, status } of measured) {
      const expected = entry.route === 'GET /denied' ? 403 : 200;
      expect([entry.route, status], `${entry.route} status`).toEqual([entry.route, expected]);
      expect(rows, `${entry.route} reads ${rows} rows (${entry.basis})`).toBeLessThanOrEqual(
        entry.budget,
      );
    }
  });
});

/** `count` copies of `template` with fresh ids, `change` giving each its own unique fields. */
let nextId = 0;
const freshId = () =>
  `01900000-0000-7000-8000-${(0xa00000000 + nextId++).toString(16).padStart(12, '0')}`;

function copies<T extends { id: string }>(
  template: T,
  count: number,
  change: (index: number) => Partial<T>,
): T[] {
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: freshId(),
    ...change(index),
  }));
}

describe('AC-BUD-02 every paged list is read one page at a time', () => {
  it('stays inside the budgets with every list past its page size', async () => {
    // Volume that fills every page: a dropped LIMIT then reads far past the budget.
    const [member] = await plain.db.select().from(users).where(eq(users.id, ids.member!));
    const [post] = await plain.db.select().from(posts).where(eq(posts.id, ids.post!));
    const [photo] = await plain.db.select().from(media).where(eq(media.id, ids.media!));
    const [comment] = await plain.db.select().from(comments).limit(1);
    const [invite] = await plain.db.select().from(invites).limit(1);
    const [album] = await plain.db.select().from(albums).limit(1);
    const [page] = await plain.db.select().from(infoPages).limit(1);
    const insertAll = async <T extends { id: string }>(
      table: Parameters<typeof plain.db.insert>[0],
      rows: T[],
    ) => {
      // 100 bound values per statement is D1's limit; the rows are wide, so go in small chunks.
      for (let i = 0; i < rows.length; i += 5)
        await plain.db.insert(table).values(rows.slice(i, i + 5) as never);
    };
    await insertAll(
      users,
      copies(member!, 120, (i) => ({
        authEmail:
          i < 60 ? `a-invite-${String(i).padStart(3, '0')}@example.test` : `vol${i}@example.test`,
        displayName: `Volume Member ${i}`,
        displayNameNorm: `volume member ${i}`,
        accessSub: null,
      })),
    );
    await insertAll(
      posts,
      copies(post!, 60, (i) => ({
        title: `Volume post ${i}`,
        isPinned: false,
        lastActivityAt: Date.now() - i,
      })),
    );
    await insertAll(
      comments,
      copies(comment!, 40, (i) => ({ postId: ids.post!, createdAt: Date.now() + i })),
    );
    await insertAll(
      media,
      copies(photo!, 80, (i) => ({
        objectKey: `vol/${i}.jpg`,
        thumbKey: `vol/${i}-t.jpg`,
        createdAt: Date.now() - i,
      })),
    );
    await insertAll(
      invites,
      copies(invite!, 200, (i) => ({
        email: `a-invite-${String(i).padStart(3, '0')}@example.test`,
        status:
          i < 60 ? ('accepted' as const) : i < 120 ? ('pending' as const) : ('revoked' as const),
        expiresAt: i >= 60 && i < 120 ? Date.now() + 86_400_000 : null,
      })),
    );
    await insertAll(
      albums,
      copies(album!, 200, (i) => ({ name: `Volume Album ${String(i).padStart(3, '0')}` })),
    );
    await insertAll(
      infoPages,
      copies(page!, 200, (i) => ({
        slug: `vol-info-${i}`,
        title: `Volume Info ${String(i).padStart(3, '0')}`,
        isPinned: true,
        sortOrder: 10 + i,
      })),
    );
    await insertAll(
      joinRequests,
      Array.from({ length: 60 }, (_, i) => ({
        id: freshId(),
        email: `join${i}@example.test`,
        name: `Requester ${i}`,
        note: 'Synthetic note',
        ipHash: `hash${i}`,
        createdAt: Date.now() - i,
      })),
    );
    await seedChatVolume(plain, 300);

    const over: string[] = [];
    for (const entry of budgets) {
      counter.reset();
      const response = await harness.send(path(entry.path), {
        headers: await harness.as(entry.as === 'admin' ? ADMIN : MEMBER),
      });
      await harness.settleHousekeeping();
      // R-BUD-01: `/admin`'s full-index retention and photo-count scans are admin-only
      // usage/retention counts; subtract only those two so `/admin`'s page lists are
      // held to the same budget on the volume seed.
      const rows =
        entry.route === 'GET /admin'
          ? counter.rowsRead() - counter.adminIndexRowsRead()
          : counter.rowsRead();
      await response.body?.cancel();
      if (entry.route !== 'GET /denied') expect(response.status, entry.route).toBe(200);
      if (rows > entry.budget) over.push(`${entry.route} reads ${rows} > ${entry.budget}`);
    }
    expect(over).toEqual([]);
  });
});
