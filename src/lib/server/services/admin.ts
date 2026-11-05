import type { z } from 'zod';
import {
  inviteCreateSchema,
  inviteRevokeSchema,
  memberPatchSchema,
  type InviteList,
} from '../../contracts/admin';
import type { ErrorCode } from '../../contracts/errors';
import type { MessageKey } from '../../i18n';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import {
  changeRole,
  countSeats,
  inviteMember,
  listInvites,
  reactivateMember,
  revokeInvite,
  SEAT_LIMIT,
  SEAT_WARNING,
  suspendMember,
  type MemberServices,
  type Outcome,
  type Refusal,
} from './members';
import { takeRateLimit } from './rate-limit';

// The admin invite screen's commands, shared by `/api/v1/admin/*` and the `/admin`
// form actions so both take the same permission, validation and rate-limit path.

export type AdminFailure = {
  ok: false;
  code: ErrorCode;
  messageKey?: MessageKey;
  fields?: Record<string, string>;
  retryAfterSeconds?: number;
};
export type AdminResult<T> = { ok: true; status: number; body: T } | AdminFailure;

const forbidden: AdminFailure = { ok: false, code: 'forbidden' };

const refusalKey: Record<Refusal, MessageKey> = {
  not_found: 'error.not_found',
  seats_full: 'admin.refusal.seats_full',
  already_member: 'admin.refusal.already_member',
  invite_accepted: 'admin.refusal.invite_accepted',
  last_admin: 'admin.refusal.last_admin',
  wrong_status: 'admin.refusal.wrong_status',
};

function refused(refusal: Refusal): AdminFailure {
  return {
    ok: false,
    code: refusal === 'not_found' ? 'not_found' : 'conflict',
    messageKey: refusalKey[refusal],
  };
}

function parse<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; data: z.infer<S> } | AdminFailure {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) fields[issue.path.join('.') || '_'] ??= issue.code;
  return { ok: false, code: 'validation', fields };
}

/** R-AUTH-21: invite changes, 30 per hour per admin. */
async function inviteLimit(context: MemberServices, member: Member): Promise<AdminFailure | null> {
  const taken = await takeRateLimit(context.database, 'invite', member.id);
  return taken.ok
    ? null
    : { ok: false, code: 'rate_limited', retryAfterSeconds: taken.retryAfterSeconds };
}

function done<T>(outcome: Outcome<T>, status = 200): AdminResult<Outcome<T> & { ok: true }> {
  return outcome.ok ? { ok: true, status, body: outcome } : refused(outcome.refusal);
}

/** R-AUTH-10/19: every invite with its member state and Access sync time, and the seats. */
export async function adminListInvites(
  context: MemberServices,
  member: Member,
): Promise<AdminResult<InviteList>> {
  if (!can(member, 'members.manage')) return forbidden;
  const now = Date.now();
  const [items, used] = await Promise.all([
    listInvites(context.database.db, now),
    countSeats(context.database.db, now),
  ]);
  return {
    ok: true,
    status: 200,
    body: { items, nextCursor: null, seats: { used, warnAt: SEAT_WARNING, limit: SEAT_LIMIT } },
  };
}

export async function adminCreateInvite(context: MemberServices, member: Member, input: unknown) {
  if (!can(member, 'members.manage')) return forbidden;
  const parsed = parse(inviteCreateSchema, input);
  if (!parsed.ok) return parsed;
  const limited = await inviteLimit(context, member);
  if (limited) return limited;
  const outcome = await inviteMember(context, member, parsed.data);
  return done(outcome, outcome.ok && outcome.created ? 201 : 200);
}

export async function adminRevokeInvite(context: MemberServices, member: Member, input: unknown) {
  if (!can(member, 'members.manage')) return forbidden;
  const parsed = parse(inviteRevokeSchema, input);
  if (!parsed.ok) return parsed;
  const limited = await inviteLimit(context, member);
  if (limited) return limited;
  return done(await revokeInvite(context, member, parsed.data.id));
}

/** R-AUTH-09, R-NAV-06: role, suspend or reactivate one member. */
export async function adminPatchMember(
  context: MemberServices,
  member: Member,
  userId: string,
  input: unknown,
) {
  if (!can(member, 'members.manage')) return forbidden;
  const parsed = parse(memberPatchSchema, input);
  if (!parsed.ok) return parsed;
  const change = parsed.data;
  if ('role' in change) return done(await changeRole(context, member, userId, change.role));
  return done(
    change.status === 'suspended'
      ? await suspendMember(context, member, userId)
      : await reactivateMember(context, member, userId),
  );
}
