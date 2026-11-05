import { applyD1Migrations, env } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import type { DirectoryPage } from '../../src/lib/contracts/profile';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { normalizeName } from '../../src/lib/shared/normalize';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, type Harness } from '../fixtures/pipeline-harness';
import { addMember, resolveProfileRoute } from '../fixtures/profile-routes';

// R-PROF-08 over 57 synthetic Vietnamese names (INV-6): paging, order and search.

const FAMILY = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Đặng', 'Bùi', 'Đỗ', 'Võ', 'Dương'];
const GIVEN = ['An', 'Bình', 'Châu', 'Dũng', 'Giang', 'Hạnh', 'Khoa', 'Ngọc', 'Phúc', 'Đức'];

let database: Database;
let harness: Harness;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  for (let index = 0; index < 57; index += 1) {
    const family = FAMILY[index % FAMILY.length]!;
    const given = GIVEN[Math.floor(index / FAMILY.length) % GIVEN.length]!;
    await addMember(database, `${family} ${index % 2 ? 'Thị' : 'Văn'} ${given}`, {
      ...(index % 7 === 0 ? { preferredName: `Bé ${given}` } : {}),
      contacts: {
        city: 'Đà Nẵng',
        phone: '+84912345678',
        visibilityJson: JSON.stringify({
          preferred_name: 'members',
          city: 'members',
          phone: 'members',
        }),
      },
    });
  }
  await addMember(database, 'Nguyễn Tạm Nghỉ', { status: 'suspended' });
  await addMember(database, 'Quiet Person', {
    preferredName: 'Secret Nick',
    contacts: { visibilityJson: JSON.stringify({ preferred_name: 'private' }) },
  });
  harness = await createHarness(database, { resolve: resolveProfileRoute });
});

async function page(query: string): Promise<DirectoryPage> {
  const response = await harness.send(`/api/v1/members${query}`, {
    headers: await harness.as(PEOPLE.active.email),
  });
  expect([query, response.status]).toEqual([query, 200]);
  return (await response.json()) as DirectoryPage;
}

async function all(q: string): Promise<DirectoryPage['items']> {
  const items: DirectoryPage['items'] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) });
    const result = await page(`?${params}`);
    expect(result.items.length).toBeLessThanOrEqual(50);
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

describe('/api/v1/members (R-PROF-08)', () => {
  it('AC-PROF-07 pages every active member, 50 at a time, in name order, once each', async () => {
    const expected = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.status, 'active'))
      .orderBy(asc(users.displayNameNorm), asc(users.id));
    expect(expected.length).toBeGreaterThan(50);
    const first = await page('');
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const items = await all('');
    expect(items.map((item) => item.id)).toEqual(expected.map((row) => row.id));
    expect(items.some((item) => item.displayName === 'Nguyễn Tạm Nghỉ')).toBe(false);
    // R-PROF-08: a list is no bulk contact listing; the city follows its visibility.
    const row = items.find((item) => item.displayName.startsWith('Đặng'));
    expect(row).toMatchObject({ city: 'Đà Nẵng' });
    expect(Object.keys(row!)).not.toContain('phone');
  });

  it('AC-PROF-07 searches case- and accent-insensitively by name prefix and preferred name', async () => {
    const nguyen = await all('nguyen');
    expect(nguyen.length).toBeGreaterThan(0);
    expect(nguyen.every((item) => normalizeName(item.displayName).includes('nguyen'))).toBe(true);
    for (const variant of ['NGUYỄN', 'Nguyễn', 'nguyễn']) {
      expect((await all(variant)).map((item) => item.id)).toEqual(nguyen.map((item) => item.id));
    }
    const dang = await all('đặng');
    expect(dang.length).toBeGreaterThan(0);
    expect((await all('DANG')).map((item) => item.id)).toEqual(dang.map((item) => item.id));
    // A word inside the name also starts a match: the given name.
    const dung = await all('dung');
    expect(dung.length).toBeGreaterThan(0);
    expect(dung.every((item) => normalizeName(item.displayName).endsWith('dung'))).toBe(true);
    // The preferred name is searched too.
    const nickname = await all('bé an');
    expect(nickname.map((item) => item.preferredName)).toContain('Bé An');
    // A preferred name hidden from the viewer is not searchable by them (INV-5).
    expect(await all('secret')).toEqual([]);
    expect((await all('quiet')).map((item) => item.displayName)).toEqual(['Quiet Person']);
    // LIKE wildcards are literal.
    expect(await all('%')).toEqual([]);
    expect(await all('_')).toEqual([]);
  });

  it('refuses a cursor the server did not write', async () => {
    const response = await harness.send('/api/v1/members?cursor=not-a-cursor', {
      headers: await harness.as(PEOPLE.active.email),
    });
    expect(response.status).toBe(400);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('validation');
  });
});
