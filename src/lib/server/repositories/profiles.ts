import { and, asc, eq, exists, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { chatMessages, comments, media, posts, profileContacts, users } from '../db/schema';
import type { DatabaseHandle } from '../ports/database';
import type { ProfileOwner } from '../services/projection';

/** A profile owner plus the columns only the owner's own views read. */
export interface StoredProfile extends ProfileOwner {
  authEmail: string;
  role: 'member' | 'admin';
  deletionKeepContent: boolean;
  createdAt: number;
}

const columns = {
  id: users.id,
  displayName: users.displayName,
  status: users.status,
  preferredName: users.preferredName,
  avatarMediaId: users.avatarMediaId,
  deletionRequestedAt: users.deletionRequestedAt,
  contactUserId: profileContacts.userId,
  contactEmail: profileContacts.contactEmail,
  phone: profileContacts.phone,
  messagingUrl: profileContacts.messagingUrl,
  city: profileContacts.city,
  bio: profileContacts.bio,
  visibilityJson: profileContacts.visibilityJson,
};

type Row = {
  id: string;
  displayName: string;
  status: ProfileOwner['status'];
  preferredName: string | null;
  avatarMediaId: string | null;
  deletionRequestedAt: number | null;
  contactUserId: string | null;
  contactEmail: string | null;
  phone: string | null;
  messagingUrl: string | null;
  city: string | null;
  bio: string | null;
  visibilityJson: string | null;
};

function toOwner(row: Row): ProfileOwner {
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.status,
    preferredName: row.preferredName,
    avatarMediaId: row.avatarMediaId,
    deletionRequestedAt: row.deletionRequestedAt,
    contacts:
      row.contactUserId === null
        ? null
        : {
            contactEmail: row.contactEmail,
            phone: row.phone,
            messagingUrl: row.messagingUrl,
            city: row.city,
            bio: row.bio,
            visibilityJson: row.visibilityJson ?? '{}',
          },
  };
}

export async function findProfile(
  db: DatabaseHandle,
  userId: string,
): Promise<StoredProfile | null> {
  const rows = await db
    .select({
      ...columns,
      authEmail: users.authEmail,
      role: users.role,
      deletionKeepContent: users.deletionKeepContent,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(profileContacts, eq(profileContacts.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...toOwner(row),
    authEmail: row.authEmail,
    role: row.role,
    deletionKeepContent: row.deletionKeepContent,
    createdAt: row.createdAt,
  };
}

/**
 * R-PROF-10/11: the member's avatar pictures go with their profile, whatever happens
 * to their content; R-MEM-20 purges the objects later. `guard` gates it inside a batch.
 */
export function deleteAvatarMedia(db: DatabaseHandle, userId: string, now: number, guard?: SQL) {
  return db
    .update(media)
    .set({ deletedAt: now })
    .where(
      and(eq(media.ownerId, userId), eq(media.mediaType, 'avatar'), isNull(media.deletedAt), guard),
    );
}

/** R-MEM-13: `id` is a live avatar picture of `userId`; a media row exists only after `complete` (INV-8). */
export function ownLiveAvatar(db: DatabaseHandle, userId: string, id: string): SQL {
  return exists(
    db
      .select({ id: media.id })
      .from(media)
      .where(
        and(
          eq(media.id, id),
          eq(media.ownerId, userId),
          eq(media.mediaType, 'avatar'),
          isNull(media.deletedAt),
        ),
      ),
  );
}

/** Whether `id` is a live avatar picture of `userId`, read now; a batch re-checks with `ownLiveAvatar`. */
export async function findOwnAvatar(db: DatabaseHandle, userId: string, id: string) {
  const rows = await db
    .select({ live: sql<number>`1` })
    .from(users)
    .where(and(eq(users.id, userId), ownLiveAvatar(db, userId, id)))
    .limit(1);
  return rows.length > 0;
}

/** `%`, `_` and the escape itself are literal in a search term. */
function likePrefix(term: string): string {
  return `${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function startsWith(column: AnyColumn, term: string): SQL {
  const prefix = likePrefix(term);
  // A name or any word in it, so "an" finds "Nguyễn Văn An" as well as "An Bùi".
  return sql`(${column} like ${prefix} escape '\\' or ${column} like ${`% ${prefix}`} escape '\\')`;
}

/**
 * R-PROF-08 / R-DB-07: active members by `display_name_norm`, keyset on
 * `(display_name_norm, id)` over the `users(status, display_name_norm)` index. `term`
 * is already normalized. Reads one row past `limit` to know whether a page follows.
 */
export async function listActiveProfiles(
  db: DatabaseHandle,
  options: { term: string | null; after: { norm: string; id: string } | null; limit: number },
): Promise<{ owners: (ProfileOwner & { displayNameNorm: string })[]; more: boolean }> {
  const conditions: SQL[] = [eq(users.status, 'active')];
  if (options.term) {
    conditions.push(
      sql`(${startsWith(users.displayNameNorm, options.term)} or ${startsWith(users.preferredNameNorm, options.term)})`,
    );
  }
  if (options.after) {
    conditions.push(
      sql`(${users.displayNameNorm}, ${users.id}) > (${options.after.norm}, ${options.after.id})`,
    );
  }
  const rows = await db
    .select({ ...columns, displayNameNorm: users.displayNameNorm })
    .from(users)
    .leftJoin(profileContacts, eq(profileContacts.userId, users.id))
    .where(and(...conditions))
    .orderBy(asc(users.displayNameNorm), asc(users.id))
    .limit(options.limit + 1);
  return {
    owners: rows
      .slice(0, options.limit)
      .map((row) => ({ ...toOwner(row), displayNameNorm: row.displayNameNorm })),
    more: rows.length > options.limit,
  };
}

/**
 * R-PROF-09: the member's own live content for their export. Not a page request, so no
 * page `LIMIT` (R-DB-07): the export is complete or it is nothing.
 */
export async function findOwnContent(db: DatabaseHandle, userId: string) {
  const [ownPosts, ownComments, ownMessages, ownMedia] = await Promise.all([
    db
      .select({
        id: posts.id,
        title: posts.title,
        bodyMd: posts.bodyMd,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
      })
      .from(posts)
      .where(and(eq(posts.authorId, userId), isNull(posts.deletedAt)))
      .orderBy(asc(posts.createdAt)),
    db
      .select({
        id: comments.id,
        postId: comments.postId,
        bodyMd: comments.bodyMd,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
      })
      .from(comments)
      .where(and(eq(comments.authorId, userId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt)),
    db
      .select({
        id: chatMessages.id,
        body: chatMessages.body,
        createdAt: chatMessages.createdAt,
        editedAt: chatMessages.editedAt,
      })
      .from(chatMessages)
      .where(and(eq(chatMessages.senderId, userId), isNull(chatMessages.deletedAt)))
      .orderBy(asc(chatMessages.createdAt)),
    db
      .select({
        id: media.id,
        mediaType: media.mediaType,
        albumId: media.albumId,
        mimeType: media.mimeType,
        width: media.width,
        height: media.height,
        sizeBytes: media.sizeBytes,
        caption: media.caption,
        takenYear: media.takenYear,
        createdAt: media.createdAt,
      })
      .from(media)
      .where(and(eq(media.ownerId, userId), isNull(media.deletedAt)))
      .orderBy(asc(media.createdAt)),
  ]);
  return { posts: ownPosts, comments: ownComments, chatMessages: ownMessages, media: ownMedia };
}
