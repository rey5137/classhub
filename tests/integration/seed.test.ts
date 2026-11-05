import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import { seedDemo } from '../../src/lib/server/db/seed-demo';
import { invites, users } from '../../src/lib/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('seedDemo on D1', () => {
  it('R-PLAT-10 seeds the same synthetic members idempotently', async () => {
    const database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
    const storage = new R2ObjectStorage(
      env.MEDIA as unknown as ConstructorParameters<typeof R2ObjectStorage>[0],
    );

    await seedDemo(database, storage);
    await seedDemo(database, storage);

    const members = await database.db.select().from(users);
    const rows = await database.db.select().from(invites);

    expect(members).toHaveLength(12);
    expect(rows).toHaveLength(12);
    expect(members.filter((member) => member.role === 'admin')).toHaveLength(1);
    expect(members.every((member) => member.authEmail.endsWith('@example.com'))).toBe(true);
  });
});
