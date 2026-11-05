import type { Database } from '../ports/database';
import { findActiveMemberByEmail, type ActiveMember } from '../repositories/users';

export type Member = ActiveMember;

/** R-AUTH-06: trim and lower-case only; no Gmail dot or plus folding. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * R-AUTH-07: the app's half of the two layers. Matching is by normalized email
 * (R-AUTH-25); a verified identity with no `active` row gets the uniform denial.
 * Invite activation (R-AUTH-08) and the subject check (R-AUTH-25) extend this step.
 */
export async function resolveMember(
  database: Database,
  identity: { email: string; subject: string },
): Promise<Member | null> {
  return findActiveMemberByEmail(database.db, normalizeEmail(identity.email));
}
