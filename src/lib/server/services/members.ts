import { and, asc, count, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { siteConfig } from '../../config';
import { t } from '../../i18n';
import { normalizeName } from '../../shared/normalize';
import { SEAT_LIMIT, SEAT_WARNING } from '../../shared/seats';
import type { Member } from '../auth/membership';
import { normalizeEmail } from '../auth/membership';
import {
  chatMessages,
  comments,
  invites,
  media,
  posts,
  profileContacts,
  users,
} from '../db/schema';
import { uuidv7 } from '../ids';
import type { Database, DatabaseHandle } from '../ports/database';
import type { RealtimeHub } from '../ports/realtime';
import { auditInsertWhere } from '../repositories/audit';
import { deleteAvatarMedia } from '../repositories/profiles';

const DAY = 86_400_000;

export { SEAT_LIMIT, SEAT_WARNING };

export type Role = 'member' | 'admin';

export type Refusal =
  | 'not_found'
  /** R-AUTH-19: active + pending already fill every seat. */
  | 'seats_full'
  /** The email already belongs to a member; suspend or reactivate instead. */
  | 'already_member'
  /** An accepted invite is a member: suspension, not revocation, removes them. */
  | 'invite_accepted'
  /** R-NAV-06: the change would leave no active admin. */
  | 'last_admin'
  /** The transition does not apply to the row's status (e.g. reactivating a revoked invite). */
  | 'wrong_status';

export type Outcome<T> = ({ ok: true } & T) | { ok: false; refusal: Refusal };

export interface MemberServices {
  database: Database;
  realtime: RealtimeHub;
}

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  userId: string | null;
  userStatus: 'invited' | 'active' | 'suspended' | null;
  displayName: string | null;
  deletionRequestedAt: number | null;
  createdAt: number;
  expiresAt: number | null;
  accessSyncedAt: number | null;
}

/** R-AUTH-08: `invite.expiryDays` from now; null keeps the invite open. */
function expiryFrom(now: number): number | null {
  const days = siteConfig.invite.expiryDays;
  return days === null ? null : now + days * DAY;
}

/** R-AUTH-19: active members plus pending, unexpired invites, as one SQL expression. */
function seatsUsed(now: number): SQL {
  return sql`((select count(*) from ${users} where ${users.status} = 'active') + (select count(*) from ${invites} where ${invites.status} = 'pending' and (${invites.expiresAt} is null or ${invites.expiresAt} > ${now})))`;
}

export async function countSeats(db: DatabaseHandle, now: number = Date.now()): Promise<number> {
  const [row] = await db.select({ n: sql<number>`${seatsUsed(now)}` }).from(sql`(select 1)`);
  return Number(row?.n ?? 0);
}

/** The admin invite screen's list (R-AUTH-10); emails reach admins only (R-NAV-05). */
export async function listInvites(
  db: DatabaseHandle,
  now: number = Date.now(),
): Promise<InviteView[]> {
  const rows = await db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      status: invites.status,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      accessSyncedAt: invites.accessSyncedAt,
      userId: users.id,
      userRole: users.role,
      userStatus: users.status,
      displayName: users.displayName,
      deletionRequestedAt: users.deletionRequestedAt,
    })
    .from(invites)
    .leftJoin(users, eq(users.authEmail, invites.email))
    .orderBy(asc(invites.email));
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.userRole ?? row.role,
    status:
      row.status === 'pending' && row.expiresAt !== null && row.expiresAt <= now
        ? 'expired'
        : row.status,
    userId: row.userId,
    userStatus: row.userStatus,
    displayName: row.displayName,
    deletionRequestedAt: row.deletionRequestedAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    accessSyncedAt: row.accessSyncedAt,
  }));
}

async function findInviteByEmail(db: DatabaseHandle, email: string) {
  const rows = await db.select().from(invites).where(eq(invites.email, email)).limit(1);
  return rows[0] ?? null;
}

async function findUser(db: DatabaseHandle, where: SQL) {
  const rows = await db
    .select({ id: users.id, status: users.status, role: users.role })
    .from(users)
    .where(where)
    .limit(1);
  return rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : '';
  return /UNIQUE constraint failed/i.test(text);
}

/**
 * R-AUTH-08: a `pending` invite and an `invited` users row with the invite's role.
 * Inviting an email that is already pending changes nothing and answers the same
 * invite, so a repeated request is harmless; a revoked or expired invite is renewed
 * in place, since `invites.email` is never hard-deleted (R-DB-13).
 */
export async function inviteMember(
  services: MemberServices,
  actor: Member,
  input: { email: string; displayName: string; role: Role },
  now: number = Date.now(),
): Promise<Outcome<{ inviteId: string; created: boolean }>> {
  const { database } = services;
  const { db } = database;
  const email = normalizeEmail(input.email);
  const existing = await findInviteByEmail(db, email);
  const user = await findUser(db, eq(users.authEmail, email));

  const live = existing?.status === 'pending' && (existing.expiresAt ?? Infinity) > now;
  if (live) return { ok: true, inviteId: existing.id, created: false };
  if (existing?.status === 'accepted' || user?.status === 'active') {
    return { ok: false, refusal: 'already_member' };
  }
  if ((await countSeats(db, now)) >= SEAT_LIMIT) return { ok: false, refusal: 'seats_full' };

  const inviteId = existing?.id ?? uuidv7(now);
  const expiresAt = expiryFrom(now);
  // R-AUTH-19: the seat check above is advisory; the invite write re-checks it in the
  // same statement, so two concurrent invites cannot both take the last seat. The user
  // row and the audit follow only when the invite is now live.
  const seatFree = sql`${seatsUsed(now)} < ${SEAT_LIMIT}`;
  const inviteWrite = existing
    ? db
        .update(invites)
        .set({
          status: 'pending',
          role: input.role,
          invitedBy: actor.id,
          expiresAt,
          // Access dropped this address when it was removed; the screen must not say otherwise.
          accessSyncedAt: null,
        })
        .where(and(eq(invites.id, existing.id), seatFree))
    : db
        .insert(invites)
        .select(
          sql`select ${inviteId}, ${email}, ${actor.id}, ${input.role}, 'pending', null, ${now}, ${expiresAt} where ${seatFree}`,
        );
  const nowLive = sql`exists (select 1 from ${invites} where ${invites.id} = ${inviteId} and ${invites.status} = 'pending' and (${invites.expiresAt} is null or ${invites.expiresAt} > ${now}))`;
  const userWrite = user
    ? // A kept row (suspended with history, or invited past expiry) becomes invitable again.
      db
        .update(users)
        .set({ status: 'invited', role: input.role, updatedAt: now })
        .where(and(eq(users.id, user.id), sql`${users.status} <> 'active'`, nowLive))
    : db
        .insert(users)
        .select(
          sql`select ${uuidv7(now)}, ${email}, null, ${input.displayName}, ${normalizeName(input.displayName)}, null, null, ${input.role}, 'invited', null, null, 0, ${now}, ${now}, null where ${nowLive}`,
        );
  const event = {
    actorId: actor.id,
    action: existing ? 'invite.renewed' : 'invite.created',
    entityType: 'invite' as const,
    entityId: inviteId,
    createdAt: now,
  };
  try {
    const [written] = await database.batch([
      inviteWrite,
      userWrite,
      auditInsertWhere(db, event, nowLive),
    ]);
    if ((written?.changes ?? 0) === 0) return { ok: false, refusal: 'seats_full' };
  } catch (error) {
    // A concurrent invite of the same email won the unique index: answer that invite.
    if (!isUniqueViolation(error)) throw error;
    const winner = await findInviteByEmail(db, email);
    if (!winner || winner.status !== 'pending') throw error;
    return { ok: true, inviteId: winner.id, created: false };
  }
  return { ok: true, inviteId, created: true };
}

/**
 * R-AUTH-08/09: the invite turns `revoked` and its never-active users row is
 * suspended in the same batch, so the email cannot activate even if the clean-up
 * below never runs; the row is then deleted unless it has history (FK RESTRICT).
 */
export async function revokeInvite(
  services: MemberServices,
  actor: Member,
  inviteId: string,
  now: number = Date.now(),
): Promise<Outcome<{ changed: boolean }>> {
  const { database } = services;
  const { db } = database;
  const rows = await db.select().from(invites).where(eq(invites.id, inviteId)).limit(1);
  const invite = rows[0];
  if (!invite) return { ok: false, refusal: 'not_found' };
  if (invite.status === 'revoked') return { ok: true, changed: false };
  if (invite.status === 'accepted') return { ok: false, refusal: 'invite_accepted' };

  const pending = and(eq(invites.id, inviteId), eq(invites.status, 'pending'));
  // Only a row that was `invited` before this change is a candidate for removal.
  const before = await findUser(db, eq(users.authEmail, invite.email));
  const [audited] = await database.batch([
    auditInsertWhere(
      db,
      {
        actorId: actor.id,
        action: 'invite.revoked',
        entityType: 'invite',
        entityId: inviteId,
        createdAt: now,
      },
      sql`exists (select 1 from ${invites} where ${pending})`,
    ),
    db
      .update(users)
      .set({ status: 'suspended', updatedAt: now })
      .where(and(eq(users.authEmail, invite.email), eq(users.status, 'invited'))),
    db.update(invites).set({ status: 'revoked' }).where(pending),
  ]);
  if (before?.status === 'invited' && (audited?.changes ?? 0) > 0) {
    try {
      await db.delete(users).where(neverActive(before.id));
    } catch {
      // The row is referenced (content, an invite it sent): it stays, suspended.
    }
  }
  return { ok: true, changed: (audited?.changes ?? 0) > 0 };
}

/**
 * R-AUTH-08: a revoked row may go only while it shows no sign of ever having been a
 * member: no Access subject, no visit and no profile (contacts would cascade away).
 * Content and sent invites are guarded by FK RESTRICT on the delete itself.
 */
export function neverActive(userId: string): SQL {
  return sql`${users.id} = ${userId} and ${users.status} = 'suspended' and ${users.accessSub} is null and ${users.lastSeenAt} is null and not exists (select 1 from ${profileContacts} where ${profileContacts.userId} = ${users.id})`;
}

/** R-NAV-06: true unless the row is an active admin and the only one. */
function keepsAnAdmin(): SQL {
  return sql`(not (${users.role} = 'admin' and ${users.status} = 'active') or (select count(*) from ${users} where ${users.role} = 'admin' and ${users.status} = 'active') > 1)`;
}

/** A refused guarded change: say why from the row as it now stands. */
async function explain(
  db: DatabaseHandle,
  userId: string,
  wanted: (row: { status: string; role: string }) => boolean,
): Promise<Outcome<{ changed: boolean }>> {
  const row = await findUser(db, eq(users.id, userId));
  if (!row) return { ok: false, refusal: 'not_found' };
  if (wanted(row)) return { ok: true, changed: false };
  if (row.role === 'admin' && row.status === 'active') return { ok: false, refusal: 'last_admin' };
  return { ok: false, refusal: 'wrong_status' };
}

/**
 * R-AUTH-09 / R-CHAT-09: the status changes first, which denies the member's next
 * request (R-NAV-04); the socket close is best effort after the commit. Suspending
 * the last active admin is refused (R-NAV-06).
 */
export async function suspendMember(
  services: MemberServices,
  actor: Member,
  userId: string,
  now: number = Date.now(),
): Promise<Outcome<{ changed: boolean }>> {
  const { database } = services;
  const guard = and(eq(users.id, userId), eq(users.status, 'active'), keepsAnAdmin());
  const event = {
    actorId: actor.id,
    action: 'member.suspended',
    entityType: 'user' as const,
    entityId: userId,
    createdAt: now,
  };
  const [audited] = await database.batch([
    auditInsertWhere(database.db, event, sql`exists (select 1 from ${users} where ${guard})`),
    database.db.update(users).set({ status: 'suspended', updatedAt: now }).where(guard),
  ]);
  if ((audited?.changes ?? 0) === 0)
    return explain(database.db, userId, (row) => row.status === 'suspended');
  try {
    await services.realtime.disconnectMember(userId);
  } catch {
    // R-CHAT-09: best effort; R-CHAT-16 stops delivery regardless.
  }
  return { ok: true, changed: true };
}

/**
 * R-AUTH-09: reactivation reverses a suspension, but only for someone whose invite
 * was accepted, so a revoked invite's kept row never becomes active (R-AUTH-08).
 */
export async function reactivateMember(
  services: MemberServices,
  actor: Member,
  userId: string,
  now: number = Date.now(),
): Promise<Outcome<{ changed: boolean }>> {
  const { database } = services;
  const guard = and(
    eq(users.id, userId),
    eq(users.status, 'suspended'),
    sql`exists (select 1 from ${invites} where ${invites.email} = ${users.authEmail} and ${invites.status} = 'accepted')`,
  );
  const event = {
    actorId: actor.id,
    action: 'member.reactivated',
    entityType: 'user' as const,
    entityId: userId,
    createdAt: now,
  };
  const [audited] = await database.batch([
    auditInsertWhere(database.db, event, sql`exists (select 1 from ${users} where ${guard})`),
    database.db.update(users).set({ status: 'active', updatedAt: now }).where(guard),
  ]);
  if ((audited?.changes ?? 0) === 0)
    return explain(database.db, userId, (row) => row.status === 'active');
  return { ok: true, changed: true };
}

/** R-PROF-11: the login email after a completed deletion; lower-case for the `CHECK`. */
export function tombstoneEmail(userId: string): string {
  return `deleted+${userId.toLowerCase()}@invalid`;
}

/**
 * R-PROF-11: an admin completes a member's deletion request in one batch. Every
 * statement is guarded by the same condition (the request stands, the email is still
 * the live one, R-NAV-06 holds), so a refused or repeated completion changes nothing.
 * The content goes first, then the invite and contacts, and the `users` row last,
 * since its update ends the guard. Authorship rows keep their foreign keys (R-DB-04).
 */
export async function completeDeletion(
  services: MemberServices,
  actor: Member,
  userId: string,
  now: number = Date.now(),
): Promise<Outcome<{ changed: boolean }>> {
  const { database } = services;
  const { db } = database;
  const rows = await db
    .select({
      authEmail: users.authEmail,
      deletionRequestedAt: users.deletionRequestedAt,
      deletionKeepContent: users.deletionKeepContent,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, refusal: 'not_found' };
  const tombstone = tombstoneEmail(userId);
  if (row.authEmail === tombstone) return { ok: true, changed: false };
  if (row.deletionRequestedAt === null) return { ok: false, refusal: 'wrong_status' };

  const guard = and(
    eq(users.id, userId),
    eq(users.authEmail, row.authEmail),
    isNotNull(users.deletionRequestedAt),
    keepsAnAdmin(),
  );
  const live = sql`exists (select 1 from ${users} where ${guard})`;
  // Deleted content keeps no text: the row stays for its foreign keys, the words go.
  const content = row.deletionKeepContent
    ? []
    : [
        db
          .update(posts)
          .set({ title: '', bodyMd: '', deletedAt: now, updatedAt: now })
          .where(and(eq(posts.authorId, userId), isNull(posts.deletedAt), live)),
        db
          .update(comments)
          .set({ bodyMd: '', deletedAt: now, updatedAt: now })
          .where(and(eq(comments.authorId, userId), isNull(comments.deletedAt), live)),
        db
          .update(posts)
          .set({
            commentCount: sql`(select count(*) from ${comments} where ${comments.postId} = ${posts.id} and ${comments.deletedAt} is null)`,
          })
          .where(
            and(
              sql`${posts.id} in (select ${comments.postId} from ${comments} where ${comments.authorId} = ${userId})`,
              live,
            ),
          ),
        db
          .update(chatMessages)
          .set({ body: '', deletedAt: now })
          .where(and(eq(chatMessages.senderId, userId), isNull(chatMessages.deletedAt), live)),
        // Their photos only: `site` media (logo, banner) belong to the class, and the
        // avatar goes below either way. R-MEM-20 purges the objects after the grace period.
        db
          .update(media)
          .set({ caption: null, deletedAt: now })
          .where(
            and(
              eq(media.ownerId, userId),
              eq(media.mediaType, 'photo'),
              isNull(media.deletedAt),
              live,
            ),
          ),
      ];
  const formerMember = t(siteConfig.locale, 'member.former');
  const [audited] = await database.batch([
    auditInsertWhere(
      db,
      {
        actorId: actor.id,
        action: 'member.deletion_completed',
        entityType: 'user',
        entityId: userId,
        createdAt: now,
      },
      live,
    ),
    ...content,
    // The profile is cleared, picture included, even when the content is kept.
    deleteAvatarMedia(db, userId, now, live),
    // R-DB-13: the invite is never deleted, so its real email is rewritten instead.
    db
      .update(invites)
      .set({ email: tombstone, status: 'revoked' })
      .where(and(eq(invites.email, row.authEmail), live)),
    db.delete(profileContacts).where(and(eq(profileContacts.userId, userId), live)),
    db
      .update(users)
      .set({
        status: 'suspended',
        authEmail: tombstone,
        accessSub: null,
        displayName: formerMember,
        displayNameNorm: normalizeName(formerMember),
        preferredName: null,
        preferredNameNorm: null,
        avatarMediaId: null,
        updatedAt: now,
      })
      .where(guard),
  ]);
  if ((audited?.changes ?? 0) === 0) {
    const [current] = await db
      .select({ authEmail: users.authEmail, status: users.status, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    if (!current) return { ok: false, refusal: 'not_found' };
    // A concurrent completion won: the same end state.
    if (current.authEmail === tombstone) return { ok: true, changed: false };
    if (current.role === 'admin' && current.status === 'active') {
      return { ok: false, refusal: 'last_admin' };
    }
    return { ok: false, refusal: 'wrong_status' };
  }
  try {
    await services.realtime.disconnectMember(userId);
  } catch {
    // R-CHAT-09: best effort; the suspension already stops delivery (R-CHAT-16).
  }
  return { ok: true, changed: true };
}

/** R-NAV-06: demoting the last active admin is refused in the same statement that demotes. */
export async function changeRole(
  services: MemberServices,
  actor: Member,
  userId: string,
  role: Role,
  now: number = Date.now(),
): Promise<Outcome<{ changed: boolean }>> {
  const { database } = services;
  const guard = and(
    eq(users.id, userId),
    eq(users.status, 'active'),
    sql`${users.role} <> ${role}`,
    role === 'member' ? keepsAnAdmin() : sql`1`,
  );
  const event = {
    actorId: actor.id,
    action: `member.role_${role}`,
    entityType: 'user' as const,
    entityId: userId,
    createdAt: now,
  };
  const [audited] = await database.batch([
    auditInsertWhere(database.db, event, sql`exists (select 1 from ${users} where ${guard})`),
    database.db.update(users).set({ role, updatedAt: now }).where(guard),
  ]);
  if ((audited?.changes ?? 0) === 0)
    return explain(database.db, userId, (row) => row.status === 'active' && row.role === role);
  return { ok: true, changed: true };
}

/** R-AUTH-14: the screen recommends a second admin while only one is active. */
export async function countActiveAdmins(db: DatabaseHandle): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
  return row?.n ?? 0;
}
