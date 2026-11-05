import { and, eq, sql } from 'drizzle-orm';
import { invites, schemaMeta, siteSettings, users } from '../db/schema';
import type { DatabaseHandle } from '../ports/database';

export const SETUP_STATE_KEY = 'setup_state';

/** R-MEM-11: one request claims the hourly slot, including across Worker isolates. */
export async function claimHousekeeping(db: DatabaseHandle, now: number): Promise<boolean> {
  const rows = await db
    .update(schemaMeta)
    .set({ value: String(now) })
    .where(
      and(
        eq(schemaMeta.key, 'housekeeping_last_run_at'),
        sql`cast(${schemaMeta.value} as integer) < ${now - 3_600_000}`,
      ),
    )
    .returning({ key: schemaMeta.key });
  return rows.length === 1;
}

/** R-AUTH-12: anything but a stored `"unlocked"` (no row, bad JSON, `"locked"`) is locked. */
export async function readSetupUnlocked(db: DatabaseHandle): Promise<boolean> {
  const rows = await db
    .select({ value: siteSettings.valueJson })
    .from(siteSettings)
    .where(eq(siteSettings.key, SETUP_STATE_KEY))
    .limit(1);
  const raw = rows[0]?.value;
  if (raw === undefined) return false;
  try {
    return JSON.parse(raw) === 'unlocked';
  } catch {
    return false;
  }
}

/**
 * R-AUTH-12: the bootstrap admin is the admin whose own invite names them as the
 * inviter. `setup` creates that invite before anyone else exists, so no later
 * invite can be self-issued (`invites.invited_by` is always an existing member).
 */
export async function isBootstrapAdmin(db: DatabaseHandle, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(invites, eq(invites.email, users.authEmail))
    .where(
      and(eq(users.id, userId), eq(users.role, 'admin'), sql`${invites.invitedBy} = ${users.id}`),
    )
    .limit(1);
  return rows.length > 0;
}
