import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { siteConfig } from '../../config';
import { joinRequestSchema, type JoinQueue } from '../../contracts/join';
import { SEAT_LIMIT } from '../../shared/seats';
import { normalizeEmail, type Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import { joinRequests, users } from '../db/schema';
import { uuidv7 } from '../ids';
import { saltedHash } from '../log';
import type { DatabaseHandle } from '../ports/database';
import { auditInsertWhere, type AuditEvent } from '../repositories/audit';
import { forbidden, parse, rateLimit, refused, type AdminResult } from './admin';
import { inviteMember, pendingInviteFor, seatsUsed, type MemberServices } from './members';
import { pushAfterCommit, sendJoinPush } from './push-service';
import { takeRateLimit } from './rate-limit';

// §6.8: the public `/join` form (R-AUTH-27..29) and the admins' queue (R-AUTH-30).

/** R-AUTH-29: the cap or the free seats are reached, as one SQL expression. */
function queueFull(now: number): SQL {
  const pending = sql`(select count(*) from ${joinRequests})`;
  return sql`(${pending} >= ${siteConfig.join.maxPending} or ${pending} >= ${SEAT_LIMIT} - ${seatsUsed(now)})`;
}

/** R-AUTH-29: site-wide state; it says nothing about any email. */
export async function joinQueueFull(db: DatabaseHandle, now: number = Date.now()) {
  const [row] = await db.select({ full: sql<number>`${queueFull(now)}` }).from(sql`(select 1)`);
  return Boolean(row?.full);
}

export type JoinOutcome =
  /** R-AUTH-28: the one reply every accepted submission gets, stored or not. */
  | { kind: 'accepted' }
  | { kind: 'closed' }
  | { kind: 'invalid'; fields: Record<string, string> }
  | { kind: 'unverified' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

/**
 * `POST /join`. Nothing is stored unless every check passes (AC-AUTH-17); then one
 * guarded statement runs for every email, so the work done is the same whether it
 * writes a row or not (R-AUTH-28). No email is sent.
 */
export async function submitJoinRequest(
  context: AppContext,
  input: unknown,
  client: { address: string; salt: string },
  now: number = Date.now(),
): Promise<JoinOutcome> {
  const { database } = context;
  const { db } = database;
  if (await joinQueueFull(db, now)) return { kind: 'closed' };
  const parsed = parse(joinRequestSchema, input);
  if (!parsed.ok) return { kind: 'invalid', fields: parsed.fields ?? {} };
  const { name, note, token } = parsed.data;
  const verified = context.turnstile
    ? await context.turnstile.verify(token, client.address)
    : false;
  if (!verified) return { kind: 'unverified' };

  // The raw address is never stored or logged; its salted hash is the rate bucket.
  const ipHash = await saltedHash(client.salt, client.address);
  for (const [kind, subject] of [
    ['joinIp', ipHash],
    ['joinSite', 'site'],
  ] as const) {
    const taken = await takeRateLimit(database, kind, subject, now);
    if (!taken.ok) return { kind: 'rate_limited', retryAfterSeconds: taken.retryAfterSeconds };
  }

  const email = normalizeEmail(parsed.data.email);
  const [written] = await database.batch([
    db
      .insert(joinRequests)
      .select(
        sql`select ${uuidv7(now)}, ${email}, ${name}, ${note}, ${ipHash}, ${now} where not exists (select 1 from ${users} where ${users.authEmail} = ${email}) and not ${pendingInviteFor(email, now)} and not ${queueFull(now)}`,
      )
      .onConflictDoNothing(),
  ]);
  if ((written?.changes ?? 0) > 0) {
    // R-NTF-07: only a stored request pushes; the duplicate and full-queue paths stay silent.
    await pushAfterCommit(context, 'join', (ctx) =>
      sendJoinPush(ctx, { requestedName: name, now }),
    );
  }
  return { kind: 'accepted' };
}

/** `GET /api/v1/admin/join-requests` and the `/admin` queue card (R-AUTH-30). */
export async function adminListJoinRequests(
  context: MemberServices,
  member: Member,
  now: number = Date.now(),
): Promise<AdminResult<JoinQueue>> {
  if (!can(member, 'members.manage')) return forbidden;
  const { db } = context.database;
  const [items, full] = await Promise.all([
    db
      .select({
        id: joinRequests.id,
        name: joinRequests.name,
        email: joinRequests.email,
        note: joinRequests.note,
        createdAt: joinRequests.createdAt,
      })
      .from(joinRequests)
      .orderBy(asc(joinRequests.createdAt), asc(joinRequests.id)),
    joinQueueFull(db, now),
  ]);
  return { ok: true, status: 200, body: { items, full } };
}

function requestExists(id: string): SQL {
  return sql`exists (select 1 from ${joinRequests} where ${joinRequests.id} = ${id})`;
}

function joinEvent(actor: Member, action: string, id: string, now: number): AuditEvent {
  return { actorId: actor.id, action, entityType: 'join_request', entityId: id, createdAt: now };
}

/** A users row for `email` that is not a never-signed-in invitee: suspended, active or deleted. */
function settledUser(email: string): SQL {
  return sql`exists (select 1 from ${users} where ${users.authEmail} = ${email} and ${users.status} <> 'invited')`;
}

async function findRequest(db: DatabaseHandle, id: string) {
  const [request] = await db
    .select({ email: joinRequests.email, name: joinRequests.name })
    .from(joinRequests)
    .where(eq(joinRequests.id, id))
    .limit(1);
  return request ?? null;
}

async function hasSettledUser(db: DatabaseHandle, email: string): Promise<boolean> {
  const [row] = await db
    .select({ found: sql<number>`${settledUser(email)}` })
    .from(sql`(select 1)`);
  return Boolean(row?.found);
}

/**
 * `POST /api/v1/admin/join-requests/:id` (R-AUTH-30): the invite path of R-AUTH-08/18/19,
 * with the request deleted and audited (ids only) in the invite's own batch, only when
 * the invite is now live. The invite write itself requires, in the same statement, that
 * the request still exists (a concurrent reject wins) and that the email has no member
 * beyond a pending invitee: a request never re-invites a suspended, active or deleted
 * account (the admin decides that on the class list). Such a refusal keeps the request,
 * for the admin to reject. Approval activates no one: the first verified login does.
 */
export async function adminApproveJoinRequest(
  context: MemberServices,
  member: Member,
  id: string,
  now: number = Date.now(),
): Promise<AdminResult<{ ok: true; inviteId: string; created: boolean }>> {
  if (!can(member, 'members.manage')) return forbidden;
  const limited = await rateLimit(context, member, 'invite');
  if (limited) return limited;
  const { database } = context;
  const { db } = database;
  const request = await findRequest(db, id);
  if (!request) return refused('not_found');
  if (await hasSettledUser(db, request.email)) return refused('already_member');

  const settle = (condition: SQL) =>
    [
      auditInsertWhere(
        db,
        joinEvent(member, 'join.approved', id, now),
        and(condition, requestExists(id))!,
      ),
      db.delete(joinRequests).where(and(eq(joinRequests.id, id), condition)),
    ] as const;
  const outcome = await inviteMember(
    context,
    member,
    { email: request.email, displayName: request.name, role: 'member' },
    now,
    {
      when: and(requestExists(id), sql`not ${settledUser(request.email)}`),
      alongside: (nowLive) => [...settle(nowLive)],
    },
  );
  if (!outcome.ok) {
    // The guarded write did nothing: say why, from what holds now.
    if (!(await findRequest(db, id))) return refused('not_found');
    if (await hasSettledUser(db, request.email)) return refused('already_member');
    return refused(outcome.refusal);
  }
  if (!outcome.created) {
    // Invited since the request came in: that invite stands, and the request goes.
    const [, removed] = await database.batch(settle(sql`1 = 1`));
    if ((removed?.changes ?? 0) === 0) return refused('not_found');
  }
  return { ok: true, status: 200, body: outcome };
}

/** `DELETE /api/v1/admin/join-requests/:id` (R-AUTH-29/30): deleted at once, audited without content. */
export async function adminRejectJoinRequest(
  context: MemberServices,
  member: Member,
  id: string,
  now: number = Date.now(),
): Promise<AdminResult<{ ok: true }>> {
  if (!can(member, 'members.manage')) return forbidden;
  const limited = await rateLimit(context, member, 'invite');
  if (limited) return limited;
  const { database } = context;
  const { db } = database;
  const [, removed] = await database.batch([
    auditInsertWhere(db, joinEvent(member, 'join.rejected', id, now), requestExists(id)),
    db.delete(joinRequests).where(eq(joinRequests.id, id)),
  ]);
  if ((removed?.changes ?? 0) === 0) return refused('not_found');
  return { ok: true, status: 200, body: { ok: true } };
}
