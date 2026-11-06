import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PostPatchInput } from '../../contracts/discussions';
import { comments, media, posts, profileContacts, users } from '../db/schema';
import { uuidv7 } from '../ids';
import type { ReferencedPhoto } from '../markdown';
import type { Database } from '../ports/database';
import type { ProfileOwner } from '../services/projection';
import { auditInsertWhere } from './audit';

// R-BRD-04..08, R-DB-06..08: keyset-paged board and thread queries, atomic comment
// counters, guarded moderation with audit events, and chunked photo lookups.

export const PHOTO_LOOKUP_CHUNK = 80;

export interface PostRow {
  id: string;
  authorId: string;
  title: string;
  bodyMd: string;
  isPinned: boolean;
  isLocked: boolean;
  commentCount: number;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  deletedAt: number | null;
  author: ProfileOwner;
}

export interface CommentRow {
  id: string;
  postId: string;
  authorId: string;
  bodyMd: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  author: ProfileOwner;
}

export interface PostCursor {
  isPinned: boolean;
  lastActivityAt: number;
  id: string;
}

export interface ActivityCursor {
  lastActivityAt: number;
  id: string;
}

export interface CommentCursor {
  createdAt: number;
  id: string;
}

export interface AuthorColumns {
  authorId: string;
  displayName: string;
  status: ProfileOwner['status'];
  preferredName: string | null;
  avatarMediaId: string | null;
  deletionRequestedAt: number | null;
  visibilityJson: string | null;
}

/** Folds the joined author columns of a selected row into its `author` owner. */
export function withAuthor<T extends AuthorColumns>(row: T) {
  const {
    displayName,
    status,
    preferredName,
    avatarMediaId,
    deletionRequestedAt,
    visibilityJson,
    ...rest
  } = row;
  const author: ProfileOwner = {
    id: row.authorId,
    displayName,
    status,
    preferredName,
    avatarMediaId,
    deletionRequestedAt,
    contacts:
      visibilityJson === null
        ? null
        : {
            contactEmail: null,
            phone: null,
            messagingUrl: null,
            city: null,
            bio: null,
            visibilityJson,
          },
  };
  return { ...rest, author };
}

function selectPosts(database: Database) {
  return database.db
    .select({
      id: posts.id,
      authorId: posts.authorId,
      title: posts.title,
      bodyMd: posts.bodyMd,
      isPinned: posts.isPinned,
      isLocked: posts.isLocked,
      commentCount: posts.commentCount,
      createdAt: posts.createdAt,
      updatedAt: posts.updatedAt,
      lastActivityAt: posts.lastActivityAt,
      deletedAt: posts.deletedAt,
      displayName: users.displayName,
      status: users.status,
      preferredName: users.preferredName,
      avatarMediaId: users.avatarMediaId,
      deletionRequestedAt: users.deletionRequestedAt,
      visibilityJson: profileContacts.visibilityJson,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .leftJoin(profileContacts, eq(profileContacts.userId, posts.authorId));
}

type SelectedPost = Awaited<ReturnType<ReturnType<typeof selectPosts>['limit']>>[number];

function toPostRow(row: SelectedPost): PostRow {
  return withAuthor(row);
}

function selectComments(database: Database) {
  return database.db
    .select({
      id: comments.id,
      postId: comments.postId,
      authorId: comments.authorId,
      bodyMd: comments.bodyMd,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
      displayName: users.displayName,
      status: users.status,
      preferredName: users.preferredName,
      avatarMediaId: users.avatarMediaId,
      deletionRequestedAt: users.deletionRequestedAt,
      visibilityJson: profileContacts.visibilityJson,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .leftJoin(profileContacts, eq(profileContacts.userId, comments.authorId));
}

type SelectedComment = Awaited<ReturnType<ReturnType<typeof selectComments>['limit']>>[number];

function toCommentRow(row: SelectedComment): CommentRow {
  return withAuthor(row);
}

/** R-BRD-06, R-DB-06, R-DB-07: board query walking `posts_pinned_activity_idx`. */
export function buildBoardQuery(
  database: Database,
  options: { after: PostCursor | null; limit: number },
) {
  const conditions: (SQL | undefined)[] = [isNull(posts.deletedAt)];
  if (options.after) {
    const pinnedInt = options.after.isPinned ? 1 : 0;
    conditions.push(
      sql`(${posts.isPinned}, ${posts.lastActivityAt}, ${posts.id}) < (${pinnedInt}, ${options.after.lastActivityAt}, ${options.after.id})`,
    );
  }
  return selectPosts(database)
    .where(and(...conditions))
    .orderBy(desc(posts.isPinned), desc(posts.lastActivityAt), desc(posts.id))
    .limit(options.limit + 1);
}

export async function listBoardPosts(
  database: Database,
  options: { after: PostCursor | null; limit: number },
): Promise<{ rows: PostRow[]; more: boolean }> {
  const rows = await buildBoardQuery(database, options);
  return { rows: rows.slice(0, options.limit).map(toPostRow), more: rows.length > options.limit };
}

/**
 * R-BRD-01, R-DB-06, R-DB-07: activity-ordered query (without pinned sort). `unpinnedOnly` is
 * Home's active list, where the pinned threads are already shown above it.
 */
export function buildRecentPostsQuery(
  database: Database,
  options: { after: ActivityCursor | null; limit: number; unpinnedOnly?: boolean },
) {
  const conditions: (SQL | undefined)[] = [isNull(posts.deletedAt)];
  if (options.unpinnedOnly) conditions.push(eq(posts.isPinned, false));
  if (options.after) {
    conditions.push(
      sql`(${posts.lastActivityAt}, ${posts.id}) < (${options.after.lastActivityAt}, ${options.after.id})`,
    );
  }
  return selectPosts(database)
    .where(and(...conditions))
    .orderBy(desc(posts.lastActivityAt), desc(posts.id))
    .limit(options.limit + 1);
}

export async function listRecentPosts(
  database: Database,
  options: { after: ActivityCursor | null; limit: number; unpinnedOnly?: boolean },
): Promise<{ rows: PostRow[]; more: boolean }> {
  const rows = await buildRecentPostsQuery(database, options);
  return { rows: rows.slice(0, options.limit).map(toPostRow), more: rows.length > options.limit };
}

export async function findLivePost(database: Database, id: string): Promise<PostRow | undefined> {
  const [row] = await selectPosts(database)
    .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
    .limit(1);
  return row ? toPostRow(row) : undefined;
}

export async function insertPost(
  database: Database,
  authorId: string,
  input: { title: string; body: string },
  now: number,
): Promise<PostRow> {
  const id = uuidv7(now);
  await database.db.insert(posts).values({
    id,
    authorId,
    title: input.title,
    bodyMd: input.body,
    isPinned: false,
    isLocked: false,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    deletedAt: null,
  });
  const created = await findLivePost(database, id);
  if (!created) throw new Error('inserted post missing');
  return created;
}

/**
 * R-BRD-08: updates a live post and writes moderation `audit_events` in the same batch.
 * Edits do not move `last_activity_at`; pinning/locking alone does not mark the post edited.
 */
export async function updateLivePost(
  database: Database,
  row: PostRow,
  actorId: string,
  patch: PostPatchInput,
  now: number,
): Promise<PostRow | undefined> {
  const liveCondition = and(eq(posts.id, row.id), isNull(posts.deletedAt))!;
  const liveExists = sql`exists (select 1 from ${posts} where ${liveCondition})`;
  const contentEdited = patch.title !== undefined || patch.body !== undefined;
  const updatedAt = contentEdited ? Math.max(now, row.createdAt + 1) : row.updatedAt;

  const audits = [];
  if (contentEdited && row.authorId !== actorId) {
    audits.push(
      auditInsertWhere(
        database.db,
        {
          actorId,
          action: 'post.edit',
          entityType: 'post',
          entityId: row.id,
          createdAt: now,
        },
        liveExists,
      ),
    );
  }
  if (patch.isPinned !== undefined) {
    audits.push(
      auditInsertWhere(
        database.db,
        {
          actorId,
          action: patch.isPinned ? 'post.pin' : 'post.unpin',
          entityType: 'post',
          entityId: row.id,
          createdAt: now,
        },
        liveExists,
      ),
    );
  }
  if (patch.isLocked !== undefined) {
    audits.push(
      auditInsertWhere(
        database.db,
        {
          actorId,
          action: patch.isLocked ? 'post.lock' : 'post.unlock',
          entityType: 'post',
          entityId: row.id,
          createdAt: now,
        },
        liveExists,
      ),
    );
  }

  const updateStmt = database.db
    .update(posts)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { bodyMd: patch.body } : {}),
      ...(patch.isPinned !== undefined ? { isPinned: patch.isPinned } : {}),
      ...(patch.isLocked !== undefined ? { isLocked: patch.isLocked } : {}),
      ...(contentEdited ? { updatedAt } : {}),
    })
    .where(liveCondition);

  const [updatedResult] = await database.batch([updateStmt, ...audits]);
  if ((updatedResult?.changes ?? 0) === 0) return undefined;
  return findLivePost(database, row.id);
}

/** R-BRD-08: soft-deletes a post (blanking text) and audits when an admin deletes another member's post. */
export async function softDeletePost(
  database: Database,
  row: PostRow,
  actorId: string,
  now: number,
): Promise<boolean> {
  const liveCondition = and(eq(posts.id, row.id), isNull(posts.deletedAt))!;
  const liveExists = sql`exists (select 1 from ${posts} where ${liveCondition})`;
  const updateStmt = database.db
    .update(posts)
    .set({ title: '', bodyMd: '', deletedAt: now, updatedAt: now })
    .where(liveCondition);
  const results =
    row.authorId !== actorId
      ? await database.batch([
          auditInsertWhere(
            database.db,
            {
              actorId,
              action: 'post.delete',
              entityType: 'post',
              entityId: row.id,
              createdAt: now,
            },
            liveExists,
          ),
          updateStmt,
        ])
      : await database.batch([updateStmt]);
  return (results.at(-1)?.changes ?? 0) > 0;
}

/**
 * R-BRD-07, R-BRD-08, R-DB-06, R-DB-07: oldest-first comment list walking `comments_post_idx`.
 * Deleted comments are included only when a later live comment follows in the same thread.
 */
export function buildCommentsQuery(
  database: Database,
  options: { postId: string; after: CommentCursor | null; limit: number },
) {
  const hasLaterLive = sql`exists (
    select 1 from ${comments} as later
    where later.post_id = ${comments.postId}
      and later.deleted_at is null
      and (later.created_at, later.id) > (${comments.createdAt}, ${comments.id})
  )`;
  const conditions: (SQL | undefined)[] = [
    eq(comments.postId, options.postId),
    or(isNull(comments.deletedAt), hasLaterLive),
  ];
  if (options.after) {
    conditions.push(
      sql`(${comments.createdAt}, ${comments.id}) > (${options.after.createdAt}, ${options.after.id})`,
    );
  }
  return selectComments(database)
    .where(and(...conditions))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(options.limit + 1);
}

/**
 * R-BRD-07: the keys of up to `limit` comments before `before`, newest first. A live
 * comment follows each of them, so every one is on the visible list.
 */
export async function listCommentKeysBefore(
  database: Database,
  options: { postId: string; before: CommentCursor; limit: number },
): Promise<CommentCursor[]> {
  return database.db
    .select({ createdAt: comments.createdAt, id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.postId, options.postId),
        sql`(${comments.createdAt}, ${comments.id}) < (${options.before.createdAt}, ${options.before.id})`,
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(options.limit);
}

export async function listPostComments(
  database: Database,
  options: { postId: string; after: CommentCursor | null; limit: number },
): Promise<{ rows: CommentRow[]; more: boolean }> {
  const rows = await buildCommentsQuery(database, options);
  return {
    rows: rows.slice(0, options.limit).map(toCommentRow),
    more: rows.length > options.limit,
  };
}

export async function findLiveComment(
  database: Database,
  id: string,
): Promise<CommentRow | undefined> {
  const [row] = await selectComments(database)
    .where(
      and(
        eq(comments.id, id),
        isNull(comments.deletedAt),
        sql`exists (select 1 from ${posts} where ${posts.id} = ${comments.postId} and ${posts.deletedAt} is null)`,
      ),
    )
    .limit(1);
  return row ? toCommentRow(row) : undefined;
}

/**
 * R-BRD-06, R-BRD-07, R-DB-08: inserts a comment and increments `comment_count` + `last_activity_at`
 * in one batch, conditional on the post being live and unlocked in both statements.
 */
export async function insertComment(
  database: Database,
  postId: string,
  authorId: string,
  bodyMd: string,
  now: number,
): Promise<CommentRow | 'locked' | 'not_found'> {
  const id = uuidv7(now);
  const postUnlocked = and(
    eq(posts.id, postId),
    isNull(posts.deletedAt),
    eq(posts.isLocked, false),
  )!;
  const guardSql = sql`exists (select 1 from ${posts} where ${postUnlocked})`;

  const [inserted] = await database.batch([
    database.db
      .insert(comments)
      .select(
        sql`select ${id}, ${postId}, ${authorId}, ${bodyMd}, ${now}, ${now}, ${null} where ${guardSql}`,
      ),
    database.db
      .update(posts)
      .set({
        commentCount: sql`${posts.commentCount} + 1`,
        lastActivityAt: now,
      })
      .where(postUnlocked),
  ]);

  if ((inserted?.changes ?? 0) === 0) {
    const post = await findLivePost(database, postId);
    return post?.isLocked ? 'locked' : 'not_found';
  }

  const created = await findLiveComment(database, id);
  if (!created) throw new Error('inserted comment missing');
  return created;
}

export async function updateLiveComment(
  database: Database,
  row: CommentRow,
  actorId: string,
  bodyMd: string,
  now: number,
): Promise<CommentRow | undefined> {
  const liveCondition = and(
    eq(comments.id, row.id),
    isNull(comments.deletedAt),
    sql`exists (select 1 from ${posts} where ${posts.id} = ${comments.postId} and ${posts.deletedAt} is null)`,
  )!;
  const liveExists = sql`exists (select 1 from ${comments} where ${liveCondition})`;
  const updatedAt = Math.max(now, row.createdAt + 1);
  const updateStmt = database.db.update(comments).set({ bodyMd, updatedAt }).where(liveCondition);
  const [updatedResult] =
    row.authorId !== actorId
      ? await database.batch([
          updateStmt,
          auditInsertWhere(
            database.db,
            {
              actorId,
              action: 'comment.edit',
              entityType: 'comment',
              entityId: row.id,
              createdAt: now,
            },
            liveExists,
          ),
        ])
      : await database.batch([updateStmt]);
  if ((updatedResult?.changes ?? 0) === 0) return undefined;
  return findLiveComment(database, row.id);
}

/** R-BRD-08, R-DB-08: soft-deletes a comment, decrements `comment_count`, and audits moderation in one batch. */
export async function softDeleteComment(
  database: Database,
  row: CommentRow,
  actorId: string,
  now: number,
): Promise<boolean> {
  const liveCondition = and(
    eq(comments.id, row.id),
    isNull(comments.deletedAt),
    sql`exists (select 1 from ${posts} where ${posts.id} = ${comments.postId} and ${posts.deletedAt} is null)`,
  )!;
  const liveExists = sql`exists (select 1 from ${comments} where ${liveCondition})`;
  const decrementStmt = database.db
    .update(posts)
    .set({ commentCount: sql`max(0, ${posts.commentCount} - 1)` })
    .where(and(eq(posts.id, row.postId), liveExists));
  const deleteStmt = database.db
    .update(comments)
    .set({ bodyMd: '', deletedAt: now, updatedAt: now })
    .where(liveCondition);
  // Decrement `comment_count` and audit before setting `deleted_at` so `liveExists` still holds.
  const results =
    row.authorId !== actorId
      ? await database.batch([
          decrementStmt,
          auditInsertWhere(
            database.db,
            {
              actorId,
              action: 'comment.delete',
              entityType: 'comment',
              entityId: row.id,
              createdAt: now,
            },
            liveExists,
          ),
          deleteStmt,
        ])
      : await database.batch([decrementStmt, deleteStmt]);
  return (results.at(-1)?.changes ?? 0) > 0;
}

/**
 * R-BRD-04, R-MEM-20: batched lookup of live `photo` media rows referenced in Markdown,
 * chunked to stay well under D1's 100 bound-parameter limit.
 */
export async function findReferencedPhotos(
  database: Database,
  ids: readonly string[],
): Promise<Map<string, ReferencedPhoto>> {
  const map = new Map<string, ReferencedPhoto>();
  if (ids.length === 0) return map;

  for (let start = 0; start < ids.length; start += PHOTO_LOOKUP_CHUNK) {
    const chunk = ids.slice(start, start + PHOTO_LOOKUP_CHUNK);
    const rows = await database.db
      .select({ id: media.id, caption: media.caption })
      .from(media)
      .where(and(inArray(media.id, chunk), eq(media.mediaType, 'photo'), isNull(media.deletedAt)));
    for (const row of rows) {
      map.set(row.id.toLowerCase(), { id: row.id, caption: row.caption });
    }
  }
  return map;
}
