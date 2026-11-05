import { DEFAULT_VISIBILITY } from '../../contracts/profile';
import { normalizeName } from '../../shared/normalize';
import { uuidv7 } from '../ids';
import type { Database } from '../ports/database';
import type { ObjectStorage } from '../ports/object-storage';
import { invites, profileContacts, siteSettings, users } from './schema';

interface DemoMember {
  email: string;
  displayName: string;
  preferredName: string | null;
  role: 'member' | 'admin';
}

// Synthetic classmates only (INV-6): reserved example.com addresses, invented
// names, no real person.
const DEMO_MEMBERS: DemoMember[] = [
  { email: 'admin@example.com', displayName: 'An Bui', preferredName: 'An', role: 'admin' },
  {
    email: 'mai.nguyen@example.com',
    displayName: 'Mai Nguyen',
    preferredName: 'Mai',
    role: 'member',
  },
  {
    email: 'linh.tran@example.com',
    displayName: 'Linh Tran',
    preferredName: 'Linh',
    role: 'member',
  },
  { email: 'bao.pham@example.com', displayName: 'Bao Pham', preferredName: 'Bao', role: 'member' },
  { email: 'chi.le@example.com', displayName: 'Chi Le', preferredName: 'Chi', role: 'member' },
  { email: 'duc.vo@example.com', displayName: 'Duc Vo', preferredName: 'Duc', role: 'member' },
  {
    email: 'hanh.dang@example.com',
    displayName: 'Hanh Dang',
    preferredName: 'Hanh',
    role: 'member',
  },
  {
    email: 'khoa.hoang@example.com',
    displayName: 'Khoa Hoang',
    preferredName: 'Khoa',
    role: 'member',
  },
  { email: 'lan.do@example.com', displayName: 'Lan Do', preferredName: 'Lan', role: 'member' },
  { email: 'minh.vu@example.com', displayName: 'Minh Vu', preferredName: 'Minh', role: 'member' },
  { email: 'nga.phan@example.com', displayName: 'Nga Phan', preferredName: 'Nga', role: 'member' },
  {
    email: 'phuc.dinh@example.com',
    displayName: 'Phuc Dinh',
    preferredName: 'Phuc',
    role: 'member',
  },
];

const ADMIN_EMAIL = DEMO_MEMBERS[0]!.email;

// Invented contact details (INV-6) so the directory and member pages show each kind of
// field; the phone numbers are not dialable and the links point at no real account.
const DEMO_CONTACTS: Record<string, { city: string; bio: string; phone?: string; link?: string }> =
  {
    'mai.nguyen@example.com': {
      city: 'Hà Nội',
      bio: 'Still in touch with half the class. Ask me about the reunion.',
      phone: '+84000000001',
      link: 'https://zalo.me/demo-mai',
    },
    'linh.tran@example.com': { city: 'Huế', bio: 'Teaching chemistry now.' },
    'bao.pham@example.com': { city: 'Đà Nẵng', bio: 'Back home after ten years away.' },
    'chi.le@example.com': { city: 'TP. Hồ Chí Minh', bio: 'Photos from every trip.' },
  };

// D1 caps a statement at 100 bound variables (7 user rows x 13 columns = 91).
const INSERT_CHUNK = 7;

/**
 * @param rows - rows to insert, chunked so the query stays under D1's limit
 * @returns how many rows the inserts actually wrote (conflicts are skipped)
 */
async function insertChunked<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown[]>,
): Promise<number> {
  let inserted = 0;
  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    inserted += (await insert(rows.slice(index, index + INSERT_CHUNK))).length;
  }
  return inserted;
}

/**
 * R-PLAT-10: synthetic classmates and their invites. Idempotent: emails are
 * unique, so a second run inserts nothing. Posts, albums and images arrive with
 * their features (§7/§8); accepting storage now keeps this signature stable.
 */
export async function seedDemo(
  database: Database,
  storage: ObjectStorage,
): Promise<{ members: number; invites: number }> {
  void storage;

  const now = Date.now();
  const memberRows = DEMO_MEMBERS.map((member) => ({
    id: uuidv7(),
    authEmail: member.email,
    displayName: member.displayName,
    displayNameNorm: normalizeName(member.displayName),
    preferredName: member.preferredName,
    preferredNameNorm: member.preferredName === null ? null : normalizeName(member.preferredName),
    role: member.role,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  }));

  const insertedMembers = await insertChunked(memberRows, (chunk) =>
    database.db.insert(users).values(chunk).onConflictDoNothing().returning({ id: users.id }),
  );

  const stored = await database.db.select({ id: users.id, email: users.authEmail }).from(users);
  const idByEmail = new Map(stored.map((row) => [row.email, row.id]));
  const adminId = idByEmail.get(ADMIN_EMAIL);
  if (!adminId) throw new Error('seedDemo: demo admin is missing');

  const inviteRows = DEMO_MEMBERS.map((member) => ({
    id: uuidv7(),
    email: member.email,
    invitedBy: adminId,
    role: member.role,
    status: 'accepted' as const,
    accessSyncedAt: now,
    createdAt: now,
    expiresAt: null,
  }));

  const insertedInvites = await insertChunked(inviteRows, (chunk) =>
    database.db.insert(invites).values(chunk).onConflictDoNothing().returning({ id: invites.id }),
  );

  const contactRows = Object.entries(DEMO_CONTACTS).flatMap(([email, contact]) => {
    const userId = idByEmail.get(email);
    if (!userId) return [];
    return [
      {
        userId,
        city: contact.city,
        bio: contact.bio,
        phone: contact.phone ?? null,
        messagingUrl: contact.link ?? null,
        visibilityJson: JSON.stringify({
          ...DEFAULT_VISIBILITY,
          city: 'members',
          messaging_url: 'members',
          phone: 'admins',
        }),
        updatedAt: now,
      },
    ];
  });
  await database.db.insert(profileContacts).values(contactRows).onConflictDoNothing();

  // R-PLAT-10: the demo site is open, so `dev:offline` and e2e reach every route; a
  // deployment stays locked until `npm run unlock` (R-AUTH-12). An existing state wins.
  await database.db
    .insert(siteSettings)
    .values({ key: 'setup_state', valueJson: JSON.stringify('unlocked'), updatedAt: now })
    .onConflictDoNothing();

  return { members: insertedMembers, invites: insertedInvites };
}
