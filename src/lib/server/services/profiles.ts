import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  deletionRequestSchema,
  directoryQuerySchema,
  profilePatchSchema,
  type DirectoryPage,
  type OwnProfile,
  type ProfilePatch,
  type PublicProfile,
} from '../../contracts/profile';
import { normalizeName } from '../../shared/normalize';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import { decodeCursor, encodeCursor } from '../cursor';
import { media, profileContacts, users } from '../db/schema';
import { auditInsertWhere } from '../repositories/audit';
import {
  deleteAvatarMedia,
  findOwnAvatar,
  findOwnContent,
  findProfile,
  listActiveProfiles,
  ownLiveAvatar,
  type StoredProfile,
} from '../repositories/profiles';
import { getPrefs } from '../repositories/notification-prefs';
import { listSubscriptions } from '../repositories/push-subscriptions';
import { parse, rateLimit, type AdminFailure, type AdminResult } from './admin';
import type { MemberServices } from './members';
import { projectProfile, visibilityOf } from './projection';

// §4: the member's own profile, the directory and one member's page. Every member
// payload is built by `projectProfile` (R-PROF-04); `auth_email` leaves only in the
// owner's own `/me` (R-PROF-05).

export const DIRECTORY_PAGE = 50;

const notFound: AdminFailure = { ok: false, code: 'not_found' };
const forbidden: AdminFailure = { ok: false, code: 'forbidden' };

function ownView(member: Member, stored: StoredProfile): OwnProfile {
  return {
    profile: projectProfile(member, stored),
    authEmail: stored.authEmail,
    role: stored.role,
    visibility: visibilityOf(stored),
    deletionRequestedAt: stored.deletionRequestedAt,
    deletionKeepContent: stored.deletionKeepContent,
  };
}

/** `GET /api/v1/me` and the `/profile` page. */
export async function getOwnProfile(
  context: MemberServices,
  member: Member,
): Promise<AdminResult<OwnProfile>> {
  if (!can(member, 'profile.edit')) return forbidden;
  const stored = await findProfile(context.database.db, member.id);
  if (!stored) return notFound;
  return { ok: true, status: 200, body: ownView(member, stored) };
}

/** `GET /api/v1/members/:id`: one projected profile; a non-active owner shows the name only. */
export async function getMemberProfile(
  context: MemberServices,
  viewer: Member,
  userId: string,
): Promise<AdminResult<PublicProfile>> {
  if (!can(viewer, 'content.read')) return forbidden;
  const stored = await findProfile(context.database.db, userId);
  if (!stored) return notFound;
  return { ok: true, status: 200, body: projectProfile(viewer, stored) };
}

function encodeDirectoryCursor(norm: string, id: string): string {
  return encodeCursor([norm, id]);
}

function decodeDirectoryCursor(cursor: string): { norm: string; id: string } | null {
  const value = decodeCursor(cursor);
  return value?.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
    ? { norm: value[0], id: value[1] }
    : null;
}

/** The SQL search in `listActiveProfiles`, on a value the viewer is shown. */
function matches(name: string | undefined, term: string): boolean {
  if (!name) return false;
  const norm = normalizeName(name);
  return norm.startsWith(term) || norm.includes(` ${term}`);
}

/** `GET /api/v1/members?q=&cursor=` (R-PROF-08, R-API-03). */
export async function listMembers(
  context: MemberServices,
  viewer: Member,
  input: unknown,
): Promise<AdminResult<DirectoryPage>> {
  if (!can(viewer, 'content.read')) return forbidden;
  const parsed = parse(directoryQuerySchema, input);
  if (!parsed.ok) return parsed;
  const after = parsed.data.cursor ? decodeDirectoryCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !after)
    return { ok: false, code: 'validation', fields: { cursor: 'custom' } };
  const term = normalizeName(parsed.data.q ?? '') || null;
  const { owners, more } = await listActiveProfiles(context.database.db, {
    term,
    after,
    limit: DIRECTORY_PAGE,
  });
  const items = owners.flatMap((owner) => {
    const { id, displayName, preferredName, avatarMediaId, city } = projectProfile(viewer, owner);
    // A preferred name the viewer may not see must not be what matched (INV-5); such a
    // row is dropped, so a page can be short while its cursor still moves on.
    if (term && !matches(owner.displayNameNorm, term) && !matches(preferredName, term)) return [];
    return [
      {
        id,
        displayName,
        ...(preferredName ? { preferredName } : {}),
        ...(avatarMediaId ? { avatarMediaId } : {}),
        ...(city ? { city } : {}),
      },
    ];
  });
  const last = owners.at(-1);
  return {
    ok: true,
    status: 200,
    body: {
      items,
      nextCursor: more && last ? encodeDirectoryCursor(last.displayNameNorm, last.id) : null,
    },
  };
}

/** Each value bound as a selected column, keeping the object's key order. */
function selectedRow<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, sql`${value}`.as(key)]),
  ) as { [K in keyof T]: SQL.Aliased<T[K]> };
}

/**
 * Writes the fields present in `patch`. The first save creates the contacts row with the
 * R-PROF-02 defaults the member was already shown, merged with any visibility change.
 */
async function writeProfile(
  context: MemberServices,
  member: Member,
  patch: ProfilePatch,
  now: number,
): Promise<StoredProfile | null | 'avatar_gone'> {
  const { database } = context;
  const stored = await findProfile(database.db, member.id);
  if (!stored) return null;

  const userSet: Partial<typeof users.$inferInsert> = {};
  if (patch.displayName !== undefined) {
    userSet.displayName = patch.displayName;
    userSet.displayNameNorm = normalizeName(patch.displayName);
  }
  if (patch.preferredName !== undefined) {
    userSet.preferredName = patch.preferredName;
    userSet.preferredNameNorm =
      patch.preferredName === null ? null : normalizeName(patch.preferredName);
  }
  if (patch.avatarMediaId !== undefined) userSet.avatarMediaId = patch.avatarMediaId;

  const contactSet: Partial<typeof profileContacts.$inferInsert> = {};
  for (const key of ['contactEmail', 'phone', 'messagingUrl', 'city', 'bio'] as const) {
    if (patch[key] !== undefined) contactSet[key] = patch[key];
  }
  const visibility = { ...visibilityOf(stored), ...patch.visibility };
  contactSet.visibilityJson = JSON.stringify(visibility);
  contactSet.updatedAt = now;

  // A new picture checked before may be gone by now (a removal in another tab): every
  // write waits on it inside the batch, and nothing is written when it is.
  const live =
    typeof patch.avatarMediaId === 'string'
      ? ownLiveAvatar(database.db, member.id, patch.avatarMediaId)
      : undefined;
  const [written] = await database.batch([
    database.db
      .update(users)
      .set({ ...userSet, updatedAt: now })
      .where(and(eq(users.id, member.id), live)),
    live
      ? database.db
          .insert(profileContacts)
          .select(
            database.db
              .select(
                // An insert-select names every column in table order; a new row's
                // unset fields start empty, as `values` would leave them.
                selectedRow({
                  userId: member.id,
                  contactEmail: contactSet.contactEmail ?? null,
                  phone: contactSet.phone ?? null,
                  messagingUrl: contactSet.messagingUrl ?? null,
                  city: contactSet.city ?? null,
                  bio: contactSet.bio ?? null,
                  visibilityJson: contactSet.visibilityJson,
                  updatedAt: now,
                }),
              )
              .from(users)
              .where(and(eq(users.id, member.id), live)),
          )
          .onConflictDoUpdate({ target: profileContacts.userId, set: contactSet })
      : database.db
          .insert(profileContacts)
          .values({ userId: member.id, ...contactSet })
          .onConflictDoUpdate({ target: profileContacts.userId, set: contactSet }),
    // R-PROF-10: removing the avatar removes its pictures, not just the reference; a new
    // one retires the pictures before it in the same batch (R-MEM-20 purges the objects).
    ...(patch.avatarMediaId === undefined
      ? []
      : [
          deleteAvatarMedia(
            database.db,
            member.id,
            now,
            patch.avatarMediaId === null ? undefined : and(ne(media.id, patch.avatarMediaId), live),
          ),
        ]),
  ]);
  if (live && (written?.changes ?? 0) === 0) return 'avatar_gone';
  return findProfile(database.db, member.id);
}

const invalidAvatar: AdminFailure = {
  ok: false,
  code: 'validation',
  fields: { avatarMediaId: 'invalid' },
};

/** `PATCH /api/v1/me` (R-PROF-01..06): validated, rate-limited, then written. */
export async function updateOwnProfile(
  context: MemberServices,
  member: Member,
  input: unknown,
  now: number = Date.now(),
): Promise<AdminResult<OwnProfile>> {
  if (!can(member, 'profile.edit')) return forbidden;
  const parsed = parse(profilePatchSchema, input);
  if (!parsed.ok) return parsed;
  // A foreign, photo, deleted or unknown id reads alike, so nothing leaks about it.
  const avatar = parsed.data.avatarMediaId;
  if (avatar && !(await findOwnAvatar(context.database.db, member.id, avatar)))
    return invalidAvatar;
  const limited = await rateLimit(context, member, 'profile');
  if (limited) return limited;
  const stored = await writeProfile(context, member, parsed.data, now);
  if (stored === 'avatar_gone') return invalidAvatar;
  return stored ? { ok: true, status: 200, body: ownView(member, stored) } : notFound;
}

/** R-PROF-10: every optional field and the avatar emptied at once; visibility is kept. */
export async function clearOwnProfile(
  context: MemberServices,
  member: Member,
  now: number = Date.now(),
): Promise<AdminResult<OwnProfile>> {
  if (!can(member, 'profile.edit')) return forbidden;
  const limited = await rateLimit(context, member, 'profile');
  if (limited) return limited;
  const stored = await writeProfile(
    context,
    member,
    {
      preferredName: null,
      contactEmail: null,
      phone: null,
      messagingUrl: null,
      city: null,
      bio: null,
      avatarMediaId: null,
    },
    now,
  );
  if (stored === 'avatar_gone') return invalidAvatar;
  return stored ? { ok: true, status: 200, body: ownView(member, stored) } : notFound;
}

/**
 * `POST /api/v1/me/deletion-request` (R-PROF-11): recorded once; a repeated request
 * answers the standing one, choice included, and changes nothing. From the write on,
 * `projectProfile` hides the contact fields (R-PROF-13).
 */
export async function requestDeletion(
  context: MemberServices,
  member: Member,
  input: unknown,
  now: number = Date.now(),
): Promise<AdminResult<{ ok: true; changed: boolean; requestedAt: number; keepContent: boolean }>> {
  if (!can(member, 'profile.edit')) return forbidden;
  const parsed = parse(deletionRequestSchema, input);
  if (!parsed.ok) return parsed;
  const limited = await rateLimit(context, member, 'profile');
  if (limited) return limited;
  const { database } = context;
  const open = and(eq(users.id, member.id), isNull(users.deletionRequestedAt));
  const [audited] = await database.batch([
    auditInsertWhere(
      database.db,
      {
        actorId: member.id,
        action: 'member.deletion_requested',
        entityType: 'user',
        entityId: member.id,
        createdAt: now,
      },
      sql`exists (select 1 from ${users} where ${open})`,
    ),
    database.db
      .update(users)
      .set({
        deletionRequestedAt: now,
        deletionKeepContent: parsed.data.keepContent,
        updatedAt: now,
      })
      .where(open),
  ]);
  const stored = await findProfile(database.db, member.id);
  if (!stored || stored.deletionRequestedAt === null) return notFound;
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      changed: (audited?.changes ?? 0) > 0,
      requestedAt: stored.deletionRequestedAt,
      keepContent: stored.deletionKeepContent,
    },
  };
}

/**
 * `GET /api/v1/me/export` (R-PROF-09): the requester's own profile, contacts and
 * content, with links to their own photos. No other member's data is read, and the
 * login email stays out (R-PROF-05).
 */
export async function exportOwnData(
  context: MemberServices,
  member: Member,
  now: number = Date.now(),
) {
  if (!can(member, 'data.exportOwn')) return forbidden;
  const { db } = context.database;
  const stored = await findProfile(db, member.id);
  if (!stored) return notFound;
  const content = await findOwnContent(db, member.id);
  const prefs = await getPrefs(db, member.id);
  const devices = await listSubscriptions(db, member.id);
  return {
    ok: true as const,
    status: 200,
    body: {
      exportedAt: now,
      profile: {
        id: stored.id,
        displayName: stored.displayName,
        preferredName: stored.preferredName,
        role: stored.role,
        createdAt: stored.createdAt,
        avatarMediaId: stored.avatarMediaId,
        contactEmail: stored.contacts?.contactEmail ?? null,
        phone: stored.contacts?.phone ?? null,
        messagingUrl: stored.contacts?.messagingUrl ?? null,
        city: stored.contacts?.city ?? null,
        bio: stored.contacts?.bio ?? null,
        visibility: visibilityOf(stored),
        deletionRequestedAt: stored.deletionRequestedAt,
      },
      posts: content.posts,
      comments: content.comments,
      chatMessages: content.chatMessages,
      media: content.media.map((item) => ({
        ...item,
        links: { image: `/api/v1/media/${item.id}/image`, thumb: `/api/v1/media/${item.id}/thumb` },
      })),
      // R-PROF-09 / R-NTF-02: notification kinds, mute and device labels only (never endpoints or keys).
      notificationKinds: prefs.kinds,
      muteUntil: prefs.muteUntil,
      devices: devices.map(({ deviceLabel, createdAt }) => ({ deviceLabel, createdAt })),
    },
  };
}
