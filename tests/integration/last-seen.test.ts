import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { PEOPLE, seedMembership, setSetupState } from '../fixtures/membership';
import { createHarness } from '../fixtures/pipeline-harness';

// R-AUTH-26: last_seen_at moves at most once an hour per member and never blocks a request.

const HOUR = 60 * 60 * 1000;
let database: Database;
let clock = 1_800_000_000_000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
});

async function lastSeen(id: string) {
  const rows = await database.db.select().from(users).where(eq(users.id, id));
  return rows[0]?.lastSeenAt ?? null;
}

describe('last_seen_at (R-AUTH-26)', () => {
  it('AC-AUTH-15 writes once within the hour and again after an hour', async () => {
    const harness = await createHarness(database, { now: () => clock });
    const headers = await harness.as(PEOPLE.active.email);
    expect(await lastSeen(PEOPLE.active.id)).toBeNull();

    expect((await harness.send('/', { headers })).status).toBe(200);
    const first = clock;
    expect(await lastSeen(PEOPLE.active.id)).toBe(first);

    clock += HOUR - 1;
    expect((await harness.send('/api/v1/me', { headers })).status).toBe(200);
    expect(await lastSeen(PEOPLE.active.id)).toBe(first);

    clock += 2;
    await harness.send('/', { headers, isDataRequest: true });
    expect(await lastSeen(PEOPLE.active.id)).toBe(clock);
  });

  it('AC-AUTH-15 writes nothing for a suspended or unknown login', async () => {
    const harness = await createHarness(database, { now: () => clock });
    for (const email of [PEOPLE.suspended.email, PEOPLE.unknown.email]) {
      await harness.send('/', { headers: await harness.as(email) });
    }
    expect(await lastSeen(PEOPLE.suspended.id)).toBeNull();
    const all = await database.db.select().from(users);
    expect(all.filter((row) => row.lastSeenAt !== null).map((row) => row.id)).toEqual([
      PEOPLE.active.id,
    ]);
  });

  it('AC-AUTH-15 never fails the request when the write fails', async () => {
    const headersOf = async (h: Awaited<ReturnType<typeof createHarness>>) =>
      h.as(PEOPLE.admin.email);
    const warm = await createHarness(database, { now: () => clock });
    await warm.send('/', { headers: await headersOf(warm) }); // records the sub
    await database.db.update(users).set({ lastSeenAt: null }).where(eq(users.id, PEOPLE.admin.id));

    const failing = {
      ...database,
      db: new Proxy(database.db, {
        get(target, key, receiver) {
          if (key === 'update') {
            return () => {
              throw new Error(`write failed for ${PEOPLE.admin.id}`);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      }),
    } as Database;
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(' '))),
    );
    try {
      const harness = await createHarness(failing, { now: () => clock });
      const response = await harness.send('/', { headers: await headersOf(harness) });
      expect(response.status).toBe(200);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(await lastSeen(PEOPLE.admin.id)).toBeNull();
    // R-AUTH-23: the raw member id never reaches a log line.
    expect(lines.some((line) => line.includes('lastSeenError'))).toBe(true);
    expect(lines.some((line) => line.includes(PEOPLE.admin.id))).toBe(false);
  });

  it('AC-AUTH-15 writes nothing while the site is locked for a non-bootstrap member', async () => {
    await setSetupState(database, 'locked');
    const harness = await createHarness(database, { now: () => clock + 10 * HOUR });
    const response = await harness.send('/', { headers: await harness.as(PEOPLE.active.email) });
    expect(response.status).not.toBe(200);
    expect(await lastSeen(PEOPLE.active.id)).toBe(clock);
    await setSetupState(database, 'unlocked');
  });
});
