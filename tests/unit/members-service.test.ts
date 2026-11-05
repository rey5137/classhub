import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { auditEvents, invites, profileContacts, users } from '../../src/lib/server/db/schema';
import {
  changeRole,
  countSeats,
  inviteMember,
  reactivateMember,
  revokeInvite,
  SEAT_LIMIT,
  suspendMember,
  type MemberServices,
} from '../../src/lib/server/services/members';
import { takeRateLimit } from '../../src/lib/server/services/rate-limit';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { recordingHub } from '../fixtures/pipeline-harness';

type LocalDatabase = ReturnType<typeof createLocalDatabase>;

let database: LocalDatabase;
let services: MemberServices & { realtime: ReturnType<typeof recordingHub> };
const admin = { id: PEOPLE.admin.id, role: 'admin' as const, displayName: 'Class Admin' };

beforeEach(async () => {
  database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
  await seedMembership(database);
  services = { database, realtime: recordingHub() };
});

afterEach(() => database.close());

async function userRow(id: string) {
  const rows = await database.db.select().from(users).where(eq(users.id, id));
  return rows[0];
}

async function audit(action: string) {
  return database.db.select().from(auditEvents).where(eq(auditEvents.action, action));
}

describe('last active admin (R-NAV-06)', () => {
  it('AC-NAV-05 refuses to suspend the last active admin', async () => {
    const result = await suspendMember(services, admin, admin.id);
    expect(result).toEqual({ ok: false, refusal: 'last_admin' });
    expect((await userRow(admin.id))?.status).toBe('active');
    expect(await audit('member.suspended')).toHaveLength(0);
    expect(services.realtime.disconnected).toEqual([]);
  });

  it('AC-NAV-05 refuses to demote the last active admin', async () => {
    const result = await changeRole(services, admin, admin.id, 'member');
    expect(result).toEqual({ ok: false, refusal: 'last_admin' });
    expect((await userRow(admin.id))?.role).toBe('admin');
    expect(await audit('member.role_member')).toHaveLength(0);
  });

  it('AC-NAV-05 allows either once a second admin is active', async () => {
    expect(await changeRole(services, admin, PEOPLE.active.id, 'admin')).toEqual({
      ok: true,
      changed: true,
    });
    expect(await changeRole(services, admin, admin.id, 'member')).toEqual({
      ok: true,
      changed: true,
    });
    // Now the promoted member is the last admin.
    expect(await suspendMember(services, admin, PEOPLE.active.id)).toEqual({
      ok: false,
      refusal: 'last_admin',
    });
  });

  it('AC-NAV-05 does not count a suspended admin as the remaining one', async () => {
    await database.db.update(users).set({ role: 'admin' }).where(eq(users.id, PEOPLE.suspended.id));
    expect(await suspendMember(services, admin, admin.id)).toEqual({
      ok: false,
      refusal: 'last_admin',
    });
  });
});

describe('suspend and reactivate (R-AUTH-09)', () => {
  it('suspends, disconnects and audits once; a repeat changes nothing', async () => {
    expect(await suspendMember(services, admin, PEOPLE.active.id)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await suspendMember(services, admin, PEOPLE.active.id)).toEqual({
      ok: true,
      changed: false,
    });
    expect((await userRow(PEOPLE.active.id))?.status).toBe('suspended');
    expect(services.realtime.disconnected).toEqual([PEOPLE.active.id]);
    const events = await audit('member.suspended');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: admin.id, entityId: PEOPLE.active.id });
  });

  it('reactivates a suspended member whose invite was accepted, once', async () => {
    await database.db.insert(invites).values({
      id: 'inv-acc',
      email: PEOPLE.active.email,
      invitedBy: admin.id,
      status: 'accepted',
    });
    await suspendMember(services, admin, PEOPLE.active.id);
    expect(await reactivateMember(services, admin, PEOPLE.active.id)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await reactivateMember(services, admin, PEOPLE.active.id)).toEqual({
      ok: true,
      changed: false,
    });
    expect((await userRow(PEOPLE.active.id))?.status).toBe('active');
    expect(await audit('member.reactivated')).toHaveLength(1);
  });

  it('never reactivates a row whose invite was revoked (R-AUTH-08)', async () => {
    const outcome = await inviteMember(services, admin, {
      email: 'kept.row@example.test',
      displayName: 'Kept Row',
      role: 'member',
    });
    if (!outcome.ok) throw new Error('invite refused');
    await revokeInvite(services, admin, outcome.inviteId);
    const [row] = await database.db
      .select()
      .from(users)
      .where(eq(users.authEmail, 'kept.row@example.test'));
    expect(row).toBeUndefined();
    // A suspended row without an accepted invite stays suspended.
    expect(await reactivateMember(services, admin, PEOPLE.suspended.id)).toEqual({
      ok: false,
      refusal: 'wrong_status',
    });
    expect((await userRow(PEOPLE.suspended.id))?.status).toBe('suspended');
  });
});

describe('invites (R-AUTH-08, R-AUTH-19)', () => {
  const input = {
    email: '  New.Classmate@Example.test ',
    displayName: 'New Classmate',
    role: 'member' as const,
  };

  it('creates a pending invite and an invited row; a duplicate request answers the same invite', async () => {
    const first = await inviteMember(services, admin, input);
    const second = await inviteMember(services, admin, input);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toEqual({ ok: true, created: false, inviteId: first.ok ? first.inviteId : '' });
    const rows = await database.db
      .select()
      .from(invites)
      .where(eq(invites.email, 'new.classmate@example.test'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', invitedBy: admin.id, role: 'member' });
    expect(rows[0]?.expiresAt).toBe((rows[0]?.createdAt ?? 0) + 30 * 86_400_000);
    const [user] = await database.db
      .select()
      .from(users)
      .where(eq(users.authEmail, 'new.classmate@example.test'));
    expect(user).toMatchObject({ status: 'invited', role: 'member', displayName: 'New Classmate' });
    expect(await audit('invite.created')).toHaveLength(1);
  });

  it('refuses an email that is already a member', async () => {
    expect(await inviteMember(services, admin, { ...input, email: PEOPLE.active.email })).toEqual({
      ok: false,
      refusal: 'already_member',
    });
  });

  it('renews a revoked or expired invite in place and audits it', async () => {
    const renewedRevoked = await inviteMember(services, admin, {
      ...input,
      email: PEOPLE.revoked.email,
    });
    const renewedExpired = await inviteMember(services, admin, {
      ...input,
      email: PEOPLE.expired.email,
      role: 'admin',
    });
    expect(renewedRevoked).toEqual({
      ok: true,
      created: true,
      inviteId: '01900000-0000-7000-8000-0000000000a1',
    });
    expect(renewedExpired).toEqual({
      ok: true,
      created: true,
      inviteId: '01900000-0000-7000-8000-0000000000a2',
    });
    const [expired] = await database.db
      .select()
      .from(invites)
      .where(eq(invites.email, PEOPLE.expired.email));
    expect(expired).toMatchObject({ status: 'pending', role: 'admin' });
    expect(expired?.expiresAt ?? 0).toBeGreaterThan(Date.now());
    expect((await userRow(PEOPLE.expired.id))?.role).toBe('admin');
    expect(await audit('invite.renewed')).toHaveLength(2);
  });

  it('revokes once: the invite turns revoked, the never-active row goes, a repeat is a no-op', async () => {
    const outcome = await inviteMember(services, admin, input);
    if (!outcome.ok) throw new Error('invite refused');
    expect(await revokeInvite(services, admin, outcome.inviteId)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await revokeInvite(services, admin, outcome.inviteId)).toEqual({
      ok: true,
      changed: false,
    });
    const [invite] = await database.db
      .select()
      .from(invites)
      .where(eq(invites.id, outcome.inviteId));
    expect(invite?.status).toBe('revoked');
    const [user] = await database.db
      .select()
      .from(users)
      .where(eq(users.authEmail, 'new.classmate@example.test'));
    expect(user).toBeUndefined();
    expect(await audit('invite.revoked')).toHaveLength(1);
  });

  it('keeps a revoked row that has history, suspended', async () => {
    const outcome = await inviteMember(services, admin, input);
    if (!outcome.ok) throw new Error('invite refused');
    const [user] = await database.db
      .select()
      .from(users)
      .where(eq(users.authEmail, 'new.classmate@example.test'));
    // The invited row is referenced (it sent an invite), so FK RESTRICT keeps it.
    await database.db
      .insert(invites)
      .values({ id: 'inv-by-new', email: 'other@example.test', invitedBy: user!.id });
    await revokeInvite(services, admin, outcome.inviteId);
    expect((await userRow(user!.id))?.status).toBe('suspended');
  });

  it('refuses revoking an accepted invite and an unknown id', async () => {
    await database.db.insert(invites).values({
      id: 'inv-acc',
      email: PEOPLE.active.email,
      invitedBy: admin.id,
      status: 'accepted',
    });
    expect(await revokeInvite(services, admin, 'inv-acc')).toEqual({
      ok: false,
      refusal: 'invite_accepted',
    });
    expect(await revokeInvite(services, admin, 'nope')).toEqual({
      ok: false,
      refusal: 'not_found',
    });
  });

  it('R-AUTH-19 counts active members and live invites, and refuses at the seat limit', async () => {
    // Seeded: two active members, one live pending invite would count, the expired one does not.
    expect(await countSeats(database.db)).toBe(2);
    for (let index = 0; index < SEAT_LIMIT - 2; index += 1) {
      const result = await inviteMember(services, admin, {
        email: `seat.${index}@example.test`,
        displayName: `Seat ${index}`,
        role: 'member',
      });
      expect(result.ok).toBe(true);
    }
    expect(await countSeats(database.db)).toBe(SEAT_LIMIT);
    expect(await inviteMember(services, admin, input)).toEqual({
      ok: false,
      refusal: 'seats_full',
    });
  });
});

describe('races and kept rows', () => {
  it('R-AUTH-19 two concurrent invites cannot both take the last seat', async () => {
    for (let index = 0; index < SEAT_LIMIT - 3; index += 1) {
      await inviteMember(services, admin, {
        email: `filler.${index}@example.test`,
        displayName: `Filler ${index}`,
        role: 'member',
      });
    }
    expect(await countSeats(database.db)).toBe(SEAT_LIMIT - 1);
    const results = await Promise.all(
      ['race.one@example.test', 'race.two@example.test'].map((email) =>
        inviteMember(services, admin, { email, displayName: 'Racer', role: 'member' }),
      ),
    );
    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(results).toContainEqual({ ok: false, refusal: 'seats_full' });
    expect(await countSeats(database.db)).toBe(SEAT_LIMIT);
    const losers = await database.db.select().from(users).where(eq(users.status, 'invited'));
    expect(losers.filter((row) => row.authEmail.startsWith('race.'))).toHaveLength(1);
  });

  it('R-AUTH-08 revoking a re-invited former member keeps their row and profile', async () => {
    await database.db.insert(profileContacts).values({ userId: PEOPLE.suspended.id, city: 'Hue' });
    const outcome = await inviteMember(services, admin, {
      email: PEOPLE.suspended.email,
      displayName: 'Suspended Member',
      role: 'member',
    });
    if (!outcome.ok) throw new Error('invite refused');
    expect((await userRow(PEOPLE.suspended.id))?.status).toBe('invited');
    await revokeInvite(services, admin, outcome.inviteId);
    expect((await userRow(PEOPLE.suspended.id))?.status).toBe('suspended');
    const contacts = await database.db
      .select()
      .from(profileContacts)
      .where(eq(profileContacts.userId, PEOPLE.suspended.id));
    expect(contacts).toHaveLength(1);
  });
});

describe('rate limits (R-AUTH-21)', () => {
  it('admits up to the limit per bucket, then answers when a slot frees', async () => {
    const now = 1_000_000_000;
    for (let index = 0; index < 30; index += 1) {
      expect(await takeRateLimit(database, 'invite', admin.id, now + index)).toEqual({ ok: true });
    }
    expect(await takeRateLimit(database, 'invite', admin.id, now + 60_000)).toEqual({
      ok: false,
      retryAfterSeconds: 3540,
    });
    // Another member's bucket and another kind are separate.
    expect(await takeRateLimit(database, 'invite', PEOPLE.active.id, now)).toEqual({ ok: true });
    expect(await takeRateLimit(database, 'profile', admin.id, now)).toEqual({ ok: true });
    // An hour after the first event its slot is free again, and expired events are pruned.
    expect(await takeRateLimit(database, 'invite', admin.id, now + 3_600_000)).toEqual({
      ok: true,
    });
  });
});

describe('invite name normalization (R-PROF-08)', () => {
  it('stores the accent-folded display name the directory searches', async () => {
    const outcome = await inviteMember(services, admin, {
      email: 'dang.duc@example.test',
      displayName: 'Đặng Đức',
      role: 'member',
    });
    expect(outcome.ok).toBe(true);
    const [row] = await database.db
      .select({ norm: users.displayNameNorm })
      .from(users)
      .where(eq(users.authEmail, 'dang.duc@example.test'));
    expect(row?.norm).toBe('dang duc');
  });
});
