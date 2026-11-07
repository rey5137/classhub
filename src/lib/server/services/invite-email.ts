import { and, eq, inArray, max } from 'drizzle-orm';
import { siteConfig } from '../../config';
import { mediumDate } from '../../shared/time';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import { auditEvents, invites, users } from '../db/schema';
import { logLine } from '../log';
import type { Mailer } from '../ports/mailer';
import { auditInsert } from '../repositories/audit';
import { forbidden, rateLimit, refused, type AdminResult } from './admin';
import type { DatabaseHandle } from '../ports/database';
import type { MemberServices } from './members';

/**
 * R-AUTH-31: the invite email, in Vietnamese. Sent only when an admin presses the button on a
 * pending invite, after adding the address to the Access policy (R-AUTH-18), so it never
 * tells someone to sign in before they can.
 */
export function inviteEmail(input: {
  siteName: string;
  origin: string;
  inviteeName: string | null;
  inviterName: string;
  expiresAt: number | null;
}): { subject: string; text: string } {
  const greeting = input.inviteeName ? `Chào ${input.inviteeName},` : 'Chào bạn,';
  const expiry = input.expiresAt
    ? `\nLời mời có hiệu lực đến ngày ${mediumDate(input.expiresAt, 'vi', siteConfig.timeZone)}.\n`
    : '';
  return {
    subject: `Lời mời tham gia ${input.siteName}`,
    text: `${greeting}

${input.inviterName} đã mời bạn vào trang lớp ${input.siteName}.

Mở ${input.origin} và đăng nhập bằng chính địa chỉ email này: chọn Google, hoặc nhập email để nhận mã đăng nhập gửi về hộp thư.
${expiry}
Hẹn gặp bạn trên trang lớp!
`,
  };
}

export async function adminSendInviteEmail(
  context: MemberServices & { mailer?: Mailer },
  member: Member,
  inviteId: string,
  site: { name: string; origin: string },
  now: number = Date.now(),
): Promise<AdminResult<{ ok: true }>> {
  if (!can(member, 'members.manage')) return forbidden;
  if (!context.mailer) {
    return { ok: false, code: 'unavailable', messageKey: 'admin.inviteEmail.unavailable' };
  }
  const limited = await rateLimit(context, member, 'invite');
  if (limited) return limited;
  const { db } = context.database;
  const [invite] = await db
    .select({
      email: invites.email,
      status: invites.status,
      expiresAt: invites.expiresAt,
      name: users.displayName,
    })
    .from(invites)
    .leftJoin(users, eq(users.authEmail, invites.email))
    .where(eq(invites.id, inviteId))
    .limit(1);
  if (!invite) return refused('not_found');
  if (invite.status !== 'pending' || (invite.expiresAt !== null && invite.expiresAt <= now)) {
    return refused('wrong_status');
  }
  const message = inviteEmail({
    siteName: site.name,
    origin: site.origin,
    inviteeName: invite.name,
    inviterName: member.displayName,
    expiresAt: invite.expiresAt,
  });
  try {
    await context.mailer.send({ to: invite.email, fromName: site.name, ...message });
  } catch (error) {
    // INV-5: no address in the log, only the failure's kind.
    logLine({ mail: 'invite_failed', error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, code: 'unavailable', messageKey: 'admin.inviteEmail.failed' };
  }
  await auditInsert(db, {
    actorId: member.id,
    action: 'invite.emailed',
    entityType: 'invite',
    entityId: inviteId,
    createdAt: now,
  });
  return { ok: true, status: 200, body: { ok: true } };
}

/** R-AUTH-31: when each of these invites was last emailed, from the `invite.emailed` audit rows. */
export async function lastInviteEmails(
  db: DatabaseHandle,
  inviteIds: string[],
): Promise<Record<string, number>> {
  if (inviteIds.length === 0) return {};
  const rows = await db
    .select({ id: auditEvents.entityId, at: max(auditEvents.createdAt) })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, 'invite.emailed'), inArray(auditEvents.entityId, inviteIds)))
    .groupBy(auditEvents.entityId);
  const result: Record<string, number> = {};
  for (const row of rows) if (row.id && row.at !== null) result[row.id] = row.at;
  return result;
}
