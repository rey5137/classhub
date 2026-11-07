import { normalizeEmail } from '../../shared/normalize';
import type { Database } from '../ports/database';
import { resetUnseenPushes } from '../repositories/notification-prefs';
import {
  activateInvitedUser,
  findUserByEmail,
  recordAccessSub,
  type ActiveMember,
} from '../repositories/users';

export type Member = ActiveMember;

export { normalizeEmail };

/**
 * R-AUTH-07: the app's half of the two layers. Matching is by normalized email
 * (R-AUTH-25); an `invited` row becomes active on its first verified login
 * (R-AUTH-08), and anything else without an `active` row gets the uniform denial.
 * No row is ever created here: an email with no invite stays unknown.
 */
export async function resolveMember(
  database: Database,
  identity: { email: string; subject: string },
  now: number = Date.now(),
): Promise<Member | null> {
  const email = normalizeEmail(identity.email);
  const user = await findUserByEmail(database.db, email);
  if (!user) return null;

  if (user.status === 'invited') {
    // The activation writes `access_sub` itself, so there is nothing to compare.
    if (await activateInvitedUser(database, email, identity.subject, now)) {
      return {
        id: user.id,
        role: user.role,
        displayName: user.displayName,
        avatarMediaId: user.avatarMediaId,
      };
    }
    // A concurrent first request (a second tab, a data request) may have won the
    // activation: accept the row if it is now active, as any later login would.
    const current = await findUserByEmail(database.db, email);
    if (current?.status !== 'active') return null;
    await recordAccessSub(database, current, identity.subject, now);
    return {
      id: current.id,
      role: current.role,
      displayName: current.displayName,
      avatarMediaId: current.avatarMediaId,
    };
  } else if (user.status === 'active') {
    await recordAccessSub(database, user, identity.subject, now);
    // R-NTF-13: opening the app resets unseen_pushes, quiet_since and summaries_sent; a write only when > 0.
    if (user.unseenPushes > 0) {
      await resetUnseenPushes(database.db, user.id, now);
    }
  } else {
    return null;
  }
  return {
    id: user.id,
    role: user.role,
    displayName: user.displayName,
    avatarMediaId: user.avatarMediaId,
  };
}
