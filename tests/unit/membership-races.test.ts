import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { resolveMember } from '../../src/lib/server/auth/membership';
import { auditEvents, users } from '../../src/lib/server/db/schema';
import { inviteMember } from '../../src/lib/server/services/members';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { recordingHub } from '../fixtures/pipeline-harness';

// Concurrent first requests of one member: each await lets the other interleave.

let database: ReturnType<typeof createLocalDatabase>;
const admin = { id: PEOPLE.admin.id, role: 'admin' as const, displayName: 'Class Admin' };

beforeEach(async () => {
  database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
  await seedMembership(database);
});

afterEach(() => database.close());

describe('concurrent logins', () => {
  it('AC-AUTH-04 both concurrent first requests of a newly invited member are let in', async () => {
    const email = 'two.tabs@example.test';
    await inviteMember({ database, realtime: recordingHub() }, admin, {
      email,
      displayName: 'Two Tabs',
      role: 'member',
    });
    const identity = { email, subject: 'sub-two-tabs' };
    const [first, second] = await Promise.all([
      resolveMember(database, identity),
      resolveMember(database, identity),
    ]);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    const [row] = await database.db.select().from(users).where(eq(users.authEmail, email));
    expect(row).toMatchObject({ status: 'active', accessSub: 'sub-two-tabs' });
  });

  it('AC-AUTH-14 concurrent requests with the same new sub record one audit event', async () => {
    await database.db
      .update(users)
      .set({ accessSub: 'sub-old' })
      .where(eq(users.id, PEOPLE.active.id));
    const identity = { email: PEOPLE.active.email, subject: 'sub-new' };
    await Promise.all([resolveMember(database, identity), resolveMember(database, identity)]);
    const events = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'access_sub_changed'));
    expect(events).toHaveLength(1);
  });
});
