import type { z } from 'zod';
import {
  inviteCreateSchema,
  inviteRevokeSchema,
  invitesQuerySchema,
  memberPatchSchema,
  type InviteList,
} from '../../contracts/admin';
import type { ErrorCode } from '../../contracts/errors';
import type { MessageKey } from '../../i18n';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import { decodeCursor, encodeCursor } from '../cursor';
import {
  changeRole,
  completeDeletion,
  countSeats,
  inviteMember,
  listInvitesPage,
  reactivateMember,
  revokeInvite,
  SEAT_LIMIT,
  SEAT_WARNING,
  suspendMember,
  type MemberServices,
  type Outcome,
  type Refusal,
} from './members';
import { takeRateLimit, type RateLimitKind } from './rate-limit';

// The admin invite screen's commands, shared by `/api/v1/admin/*` and the `/admin`
// form actions so both take the same permission, validation and rate-limit path.

export type AdminFailure = {
  ok: false;
  code: ErrorCode;
  messageKey?: MessageKey;
  fields?: Record<string, string>;
  retryAfterSeconds?: number;
  reason?: 'daily' | 'concurrent';
};
export type AdminResult<T> = { ok: true; status: number; body: T } | AdminFailure;

export const forbidden: AdminFailure = { ok: false, code: 'forbidden' };

const refusalKey: Record<Refusal, MessageKey> = {
  not_found: 'error.not_found',
  seats_full: 'admin.refusal.seats_full',
  already_member: 'admin.refusal.already_member',
  invite_accepted: 'admin.refusal.invite_accepted',
  last_admin: 'admin.refusal.last_admin',
  wrong_status: 'admin.refusal.wrong_status',
};

export function refused(refusal: Refusal): AdminFailure {
  return {
    ok: false,
    code: refusal === 'not_found' ? 'not_found' : 'conflict',
    messageKey: refusalKey[refusal],
  };
}

/** Zod at the boundary (R-DB-09): a `validation` failure names each bad field. */
export function parse<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; data: z.infer<S> } | AdminFailure {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) fields[issue.path.join('.') || '_'] ??= issue.code;
  return { ok: false, code: 'validation', fields };
}

/** R-AUTH-21: a refusal when `member` is past the `kind` limit (invites, profile writes). */
export async function rateLimit(
  context: MemberServices,
  member: Member,
  kind: RateLimitKind,
): Promise<AdminFailure | null> {
  const taken = await takeRateLimit(context.database, kind, member.id);
  return taken.ok
    ? null
    : { ok: false, code: 'rate_limited', retryAfterSeconds: taken.retryAfterSeconds };
}

function done<T>(outcome: Outcome<T>, status = 200): AdminResult<Outcome<T> & { ok: true }> {
  return outcome.ok ? { ok: true, status, body: outcome } : refused(outcome.refusal);
}

/** R-AUTH-10/19: every invite with its member state and Access sync time, and the seats. */
function decodeInviteCursor(cursor: string): string | null {
  const value = decodeCursor(cursor);
  return value?.length === 1 && typeof value[0] === 'string' && value[0].length > 0
    ? value[0]
    : null;
}

export async function adminListInvites(
  context: MemberServices,
  member: Member,
  input: unknown = {},
): Promise<AdminResult<InviteList>> {
  if (!can(member, 'members.manage')) return forbidden;
  const parsed = parse(invitesQuerySchema, input);
  if (!parsed.ok) return parsed;
  const after = parsed.data.cursor ? decodeInviteCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !after)
    return { ok: false, code: 'validation', fields: { cursor: 'custom' } };
  const now = Date.now();
  const [{ items, more }, used] = await Promise.all([
    listInvitesPage(context.database.db, { after, limit: parsed.data.limit }, now),
    countSeats(context.database.db, now),
  ]);
  const last = items.at(-1);
  return {
    ok: true,
    status: 200,
    body: {
      items,
      nextCursor: more && last ? encodeCursor([last.email]) : null,
      seats: { used, warnAt: SEAT_WARNING, limit: SEAT_LIMIT },
    },
  };
}

export async function adminCreateInvite(context: MemberServices, member: Member, input: unknown) {
  if (!can(member, 'members.manage')) return forbidden;
  const parsed = parse(inviteCreateSchema, input);
  if (!parsed.ok) return parsed;
  const limited = await rateLimit(context, member, 'invite');
  if (limited) return limited;
  const outcome = await inviteMember(context, member, parsed.data);
  return done(outcome, outcome.ok && outcome.created ? 201 : 200);
}

export async function adminRevokeInvite(context: MemberServices, member: Member, input: unknown) {
  if (!can(member, 'members.manage')) return forbidden;
  const parsed = parse(inviteRevokeSchema, input);
  if (!parsed.ok) return parsed;
  const limited = await rateLimit(context, member, 'invite');
  if (limited) return limited;
  return done(await revokeInvite(context, member, parsed.data.id));
}

/** R-AUTH-09, R-NAV-06, R-PROF-11: role, suspend, reactivate or complete a deletion. */
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
  if ('deletion' in change) return done(await completeDeletion(context, member, userId));
  return done(
    change.status === 'suspended'
      ? await suspendMember(context, member, userId)
      : await reactivateMember(context, member, userId),
  );
}
