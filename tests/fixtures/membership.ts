import { invites, siteSettings, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';

// Synthetic people for the identity tests (INV-6), one per membership state.
export const PEOPLE = {
  active: { id: '01900000-0000-7000-8000-000000000001', email: 'active.member@example.test' },
  admin: { id: '01900000-0000-7000-8000-000000000002', email: 'class.admin@example.test' },
  suspended: { id: '01900000-0000-7000-8000-000000000003', email: 'suspended.member@example.test' },
  revoked: { id: '01900000-0000-7000-8000-000000000004', email: 'revoked.invite@example.test' },
  expired: { id: '01900000-0000-7000-8000-000000000005', email: 'expired.invite@example.test' },
  unknown: { email: 'unknown.person@example.test' },
} as const;

/** Contact data that must never reach a log line (AC-AUTH-12). */
export const FIXTURE_PHONE = '+84 912 345 678';

/** R-AUTH-12: `npm run unlock`'s write; the identity suites test an open site. */
export async function setSetupState(database: Database, state: 'locked' | 'unlocked') {
  await database.db
    .insert(siteSettings)
    .values({ key: 'setup_state', valueJson: JSON.stringify(state) })
    .onConflictDoUpdate({ target: siteSettings.key, set: { valueJson: JSON.stringify(state) } });
}

export async function seedMembership(
  database: Database,
  options: { setupState?: 'locked' | 'unlocked' } = {},
): Promise<void> {
  await setSetupState(database, options.setupState ?? 'unlocked');
  const now = Date.now();
  const row = (
    person: { id: string; email: string },
    name: string,
    status: 'active' | 'invited' | 'suspended',
    role: 'member' | 'admin' = 'member',
  ) => ({
    id: person.id,
    authEmail: person.email,
    displayName: name,
    displayNameNorm: name.toLowerCase(),
    role,
    status,
    createdAt: now,
    updatedAt: now,
  });
  await database.db
    .insert(users)
    .values([
      row(PEOPLE.active, 'Active Member', 'active'),
      row(PEOPLE.admin, 'Class Admin', 'active', 'admin'),
      row(PEOPLE.suspended, 'Suspended Member', 'suspended'),
      row(PEOPLE.revoked, 'Revoked Invite', 'invited'),
      row(PEOPLE.expired, 'Expired Invite', 'invited'),
    ])
    .onConflictDoNothing();
  await database.db
    .insert(invites)
    .values([
      {
        id: '01900000-0000-7000-8000-0000000000a1',
        email: PEOPLE.revoked.email,
        invitedBy: PEOPLE.admin.id,
        status: 'revoked',
        createdAt: now,
      },
      {
        id: '01900000-0000-7000-8000-0000000000a2',
        email: PEOPLE.expired.email,
        invitedBy: PEOPLE.admin.id,
        status: 'pending',
        createdAt: now - 40 * 86_400_000,
        expiresAt: now - 10 * 86_400_000,
      },
    ])
    .onConflictDoNothing();
}
