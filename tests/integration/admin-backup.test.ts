import { isHttpError } from '@sveltejs/kit';
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { backupRuns } from '../../src/lib/server/db/schema';
import { load as adminLoad } from '../../src/routes/admin/+page.server';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, type Harness } from '../fixtures/pipeline-harness';

// Synthetic only (INV-6): fixture members and made-up backup_runs rows (R-BAK-09 holds no content).
let database: ReturnType<typeof createD1Database>;
let harness: Harness;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  harness = await createHarness(database, {
    resolve: async (event) => {
      try {
        const data = (await adminLoad(event as never)) as { backup: unknown };
        return Response.json({ backup: data.backup });
      } catch (error) {
        if (isHttpError(error)) return Response.json({ refused: true }, { status: error.status });
        throw error;
      }
    },
  });
});
beforeEach(async () => {
  await database.db.delete(backupRuns);
});

const view = async (email: string) => {
  const response = await harness.send('/admin', {
    headers: await harness.as(email),
    routeId: '/admin',
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('/admin backup status card (R-BAK-09)', () => {
  it('R-BAK-09 /admin loads the last verified backup for an admin, and none before one ran', async () => {
    expect(await view(PEOPLE.admin.email)).toEqual({
      status: 200,
      body: { backup: { last: null } },
    });
    await database.db.insert(backupRuns).values([
      {
        id: 'r1',
        kind: 'full',
        manifestSha256: 'a'.repeat(64),
        objectCount: 4,
        totalBytes: 2048,
        verifiedAt: 1_800_000_000_000,
      },
      // Recorded but not verified: never shown.
      {
        id: 'r2',
        kind: 'full',
        manifestSha256: 'b'.repeat(64),
        objectCount: 9,
        totalBytes: 9999,
        verifiedAt: null,
      },
    ]);
    expect(await view(PEOPLE.admin.email)).toEqual({
      status: 200,
      body: {
        backup: { last: { verifiedAt: 1_800_000_000_000, totalBytes: 2048, objectCount: 4 } },
      },
    });
  });

  it('R-BAK-09 a member without usage.view is refused before backup_runs is read', async () => {
    await database.db.insert(backupRuns).values({
      id: 'r1',
      kind: 'full',
      manifestSha256: 'a'.repeat(64),
      objectCount: 4,
      totalBytes: 2048,
      verifiedAt: 1_800_000_000_000,
    });
    expect(await view(PEOPLE.active.email)).toEqual({ status: 403, body: { refused: true } });
  });
});
