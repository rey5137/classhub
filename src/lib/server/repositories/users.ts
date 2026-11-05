import { and, eq } from 'drizzle-orm';
import { users } from '../db/schema';
import type { DatabaseHandle } from '../ports/database';

export interface ActiveMember {
  id: string;
  role: 'member' | 'admin';
  displayName: string;
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
