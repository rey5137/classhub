import { and, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { invites, users } from '../db/schema';
import type { Database, DatabaseHandle } from '../ports/database';
import { auditInsertWhere } from './audit';

export interface ActiveMember {
  id: string;
  role: 'member' | 'admin';
  displayName: string;
}

export type UserStatus = 'invited' | 'active' | 'suspended';

export interface UserIdentityRow extends ActiveMember {
  status: UserStatus;
  accessSub: string | null;
}

/** INV-1: only an `active` row counts; `invited` and `suspended` rows read as no member. */
export async function findActiveMemberByEmail(
  db: DatabaseHandle,
  normalizedEmail: string,
): Promise<ActiveMember | null> {
  const rows = await db
    .select({ id: users.id, role: users.role, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.authEmail, normalizedEmail), eq(users.status, 'active')))
    .limit(1);
  return rows[0] ?? null;
}

/** The one read per request: the row of any status, so the caller can activate or refuse it. */
export async function findUserByEmail(
  db: DatabaseHandle,
  normalizedEmail: string,
): Promise<UserIdentityRow | null> {
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      displayName: users.displayName,
      status: users.status,
      accessSub: users.accessSub,
    })
    .from(users)
    .where(eq(users.authEmail, normalizedEmail))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * R-AUTH-08: the guarded activation and the invite's acceptance in one batch. The
 * update changes a row only while a pending, unexpired invite exists, so a revoked
 * or expired invite changes nothing (AC-AUTH-13). Returns whether it activated.
 */
export async function activateInvitedUser(
  database: Database,
  normalizedEmail: string,
  subject: string,
  now: number,
): Promise<boolean> {
  const pendingInvite = and(
    eq(invites.email, normalizedEmail),
    eq(invites.status, 'pending'),
    or(isNull(invites.expiresAt), gt(invites.expiresAt, now)),
  );
  const [activated] = await database.batch([
    database.db
      .update(users)
      .set({ status: 'active', accessSub: subject, updatedAt: now })
      .where(
        and(
          eq(users.authEmail, normalizedEmail),
          eq(users.status, 'invited'),
          sql`exists (select 1 from ${invites} where ${pendingInvite})`,
        ),
      ),
    database.db
      .update(invites)
      .set({ status: 'accepted' })
      .where(
        and(
          pendingInvite,
          sql`exists (select 1 from ${users} where ${users.authEmail} = ${normalizedEmail} and ${users.status} = 'active')`,
        ),
      ),
  ]);
  return (activated?.changes ?? 0) > 0;
}

/**
 * R-AUTH-25: matching stays by email; the first `sub` is recorded silently (also
 * after a restore cleared it), a different one is replaced and audited without the
 * email (R-AUTH-23).
 */
export async function recordAccessSub(
  database: Database,
  user: Pick<UserIdentityRow, 'id' | 'accessSub'>,
  subject: string,
  now: number,
): Promise<void> {
  if (user.accessSub === subject) return;
  if (user.accessSub === null) {
    await database.db
      .update(users)
      .set({ accessSub: subject, updatedAt: now })
      .where(and(eq(users.id, user.id), isNull(users.accessSub)));
    return;
  }
  // The audit row is guarded like the update, so concurrent requests carrying the
  // same new `sub` record one change, not one per request.
  const changing = and(eq(users.id, user.id), ne(users.accessSub, subject));
  await database.batch([
    auditInsertWhere(
      database.db,
      {
        actorId: user.id,
        action: 'access_sub_changed',
        entityType: 'user',
        entityId: user.id,
        createdAt: now,
      },
      sql`exists (select 1 from ${users} where ${changing})`,
    ),
    database.db.update(users).set({ accessSub: subject, updatedAt: now }).where(changing),
  ]);
}

/** The login email of one user, for an admin-only screen (R-PROF-05). */
export async function findAuthEmail(db: DatabaseHandle, userId: string): Promise<string | null> {
  const rows = await db
    .select({ authEmail: users.authEmail })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.authEmail ?? null;
}

/** R-AUTH-26: `last_seen_at` moves at most once an hour per member, in one conditional UPDATE. */
export const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000;

export async function touchLastSeen(
  db: DatabaseHandle,
  userId: string,
  now: number,
): Promise<void> {
  await db
    .update(users)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.lastSeenAt), lt(users.lastSeenAt, now - LAST_SEEN_INTERVAL_MS)),
      ),
    );
}
