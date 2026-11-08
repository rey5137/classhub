import {
  commentCreateSchema,
  commentIdSchema,
  commentItemSchema,
  commentListQuerySchema,
  commentPageSchema,
  commentPatchSchema,
  discussionMutationResponseSchema,
  liveCommentSchema,
  postCreateSchema,
  postIdSchema,
  postItemSchema,
  postListQuerySchema,
  postPageSchema,
  postPatchSchema,
  postSummarySchema,
  type CommentItem,
  type CommentPage,
  type LiveComment,
  type PostItem,
  type PostPage,
  type PostSummary,
} from '../../contracts/discussions';
import type { Locale } from '../../i18n';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import { decodeCursor, encodeCursor } from '../cursor';
import { createExcerpt, extractPhotoIds, renderMarkdown, type ReferencedPhoto } from '../markdown';
import {
  findLiveComment,
  findLivePost,
  findReferencedPhotos,
  insertComment,
  insertPost,
  listBoardPosts,
  listCommentKeysBefore,
  listPostComments,
  listRecentPosts,
  softDeleteComment,
  softDeletePost,
  updateLiveComment,
  updateLivePost,
  type CommentCursor,
  type CommentRow,
  type PostCursor,
  type PostRow,
} from '../repositories/discussions';
import { parse, type AdminFailure, type AdminResult } from './admin';
import { projectProfile } from './projection';
import { pushAfterCommit, sendItemPush } from './push-service';
import { takeRateLimit } from './rate-limit';

// R-BRD-03..09, R-AUTH-21: board and thread services shared by `/api/v1/posts` and `/api/v1/comments`.

export const POSTS_PAGE = 20;
export const COMMENTS_PAGE = 20;
export const HOME_ACTIVE_THREADS = 5;

const denied: AdminFailure = { ok: false, code: 'forbidden' };
const threadLocked: AdminFailure = {
  ok: false,
  code: 'locked',
  messageKey: 'brd.threadLocked',
};

/** How a body renders: the reader's locale, and whether gallery photos may be shown. */
export interface BodyView {
  locale: Locale;
  memories: boolean;
}

/**
 * R-BRD-04 photo references for a set of bodies. R-NAV-02: with memories off nothing is
 * looked up (`null`), so every reference renders as the "not shown" note (no caption, no link).
 */
function lookupPhotos(
  context: AppContext,
  view: BodyView,
  ids: string[],
): Promise<ReadonlyMap<string, ReferencedPhoto> | null> {
  if (!view.memories) return Promise.resolve(null);
  if (ids.length === 0) return Promise.resolve(new Map());
  return findReferencedPhotos(context.database, ids);
}

/** The projected author and the viewer's edit and delete rights over a post or comment row. */
function authorAndRights(viewer: Member, row: PostRow | CommentRow) {
  const { id, displayName, avatarMediaId } = projectProfile(viewer, row.author);
  return {
    author: { id, displayName, ...(avatarMediaId ? { avatarMediaId } : {}) },
    canEdit: can(viewer, 'content.edit', { ownerId: row.authorId }),
    canDelete: can(viewer, 'content.delete', { ownerId: row.authorId }),
  };
}

function toPostSummary(viewer: Member, row: PostRow): PostSummary {
  return postSummarySchema.parse({
    id: row.id,
    title: row.title,
    excerpt: createExcerpt(row.bodyMd),
    isPinned: row.isPinned,
    isLocked: row.isLocked,
    commentCount: row.commentCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    edited: row.updatedAt > row.createdAt,
    ...authorAndRights(viewer, row),
    canModerate: can(viewer, 'thread.moderate'),
  });
}

function toPostItem(
  viewer: Member,
  row: PostRow,
  locale: Locale,
  photos: ReadonlyMap<string, ReferencedPhoto> | null,
): PostItem {
  return postItemSchema.parse({
    id: row.id,
    title: row.title,
    bodyMd: row.bodyMd,
    bodyHtml: renderMarkdown(row.bodyMd, { locale, photos }),
    isPinned: row.isPinned,
    isLocked: row.isLocked,
    commentCount: row.commentCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    edited: row.updatedAt > row.createdAt,
    ...authorAndRights(viewer, row),
    canModerate: can(viewer, 'thread.moderate'),
  });
}

function toCommentItem(
  viewer: Member,
  row: CommentRow,
  locale: Locale,
  photos: ReadonlyMap<string, ReferencedPhoto> | null,
): CommentItem {
  if (row.deletedAt !== null) {
    return commentItemSchema.parse({
      id: row.id,
      postId: row.postId,
      deleted: true,
      createdAt: row.createdAt,
    });
  }
  return liveCommentSchema.parse({
    id: row.id,
    postId: row.postId,
    deleted: false,
    bodyMd: row.bodyMd,
    bodyHtml: renderMarkdown(row.bodyMd, { locale, photos }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    edited: row.updatedAt > row.createdAt,
    ...authorAndRights(viewer, row),
  });
}

export function decodePostCursor(cursor: string): PostCursor | null {
  const value = decodeCursor(cursor);
  return value?.length === 3 &&
    (value[0] === 0 || value[0] === 1) &&
    Number.isSafeInteger(value[1]) &&
    typeof value[2] === 'string' &&
    value[2].length > 0
    ? { isPinned: value[0] === 1, lastActivityAt: value[1] as number, id: value[2] }
    : null;
}

export function encodePostCursor(row: Pick<PostRow, 'isPinned' | 'lastActivityAt' | 'id'>): string {
  return encodeCursor([row.isPinned ? 1 : 0, row.lastActivityAt, row.id]);
}

export function decodeCommentCursor(cursor: string): CommentCursor | null {
  const value = decodeCursor(cursor);
  return value?.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    typeof value[1] === 'string' &&
    value[1].length > 0
    ? { createdAt: value[0] as number, id: value[1] }
    : null;
}

export function encodeCommentCursor(row: Pick<CommentRow, 'createdAt' | 'id'>): string {
  return encodeCursor([row.createdAt, row.id]);
}

/** `GET /api/v1/posts?cursor=` (R-BRD-06, R-DB-07). Returns plain-text `excerpt`, not `bodyHtml`. */
export async function listPosts(
  context: AppContext,
  viewer: Member,
  input: unknown,
): Promise<AdminResult<PostPage>> {
  if (!can(viewer, 'content.read')) return denied;
  const parsed = parse(postListQuerySchema, input);
  if (!parsed.ok) return parsed;
  const after = parsed.data.cursor ? decodePostCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !after) {
    return { ok: false, code: 'validation', fields: { cursor: 'custom' } };
  }
  const { rows, more } = await listBoardPosts(context.database, {
    after,
    limit: POSTS_PAGE,
  });
  const last = rows.at(-1);
  return {
    ok: true,
    status: 200,
    body: postPageSchema.parse({
      items: rows.map((row) => toPostSummary(viewer, row)),
      nextCursor: more && last ? encodePostCursor(last) : null,
    }),
  };
}

/**
 * R-BRD-01: Home's pinned threads (the board's first page, pinned rows only) and the most
 * recently active unpinned threads (the pinned ones are already listed above them).
 */
export async function homeThreads(
  context: AppContext,
  viewer: Member,
): Promise<{ pinned: PostSummary[]; active: PostSummary[] }> {
  if (!can(viewer, 'content.read')) return { pinned: [], active: [] };
  const [board, recent] = await Promise.all([
    listBoardPosts(context.database, { after: null, limit: POSTS_PAGE, pinnedOnly: true }),
    listRecentPosts(context.database, {
      after: null,
      limit: HOME_ACTIVE_THREADS,
      unpinnedOnly: true,
    }),
  ]);
  return {
    pinned: board.rows.map((row) => toPostSummary(viewer, row)),
    active: recent.rows.map((row) => toPostSummary(viewer, row)),
  };
}

/** `POST /api/v1/posts` (R-BRD-05, R-AUTH-21). */
export async function createPost(
  context: AppContext,
  member: Member,
  input: unknown,
  view: BodyView,
  now = Date.now(),
): Promise<AdminResult<PostItem>> {
  if (!can(member, 'content.create')) return denied;
  const parsed = parse(postCreateSchema, input);
  if (!parsed.ok) return parsed;
  const taken = await takeRateLimit(context.database, 'post', member.id, now);
  if (!taken.ok) {
    return { ok: false, code: 'rate_limited', retryAfterSeconds: taken.retryAfterSeconds };
  }
  const row = await insertPost(context.database, member.id, parsed.data, now);
  await pushAfterCommit(context, 'thread', (ctx) =>
    sendItemPush(ctx, 'thread', {
      postId: row.id,
      threadTitle: row.title,
      actorId: member.id,
      actorName: member.displayName,
      now,
    }),
  );
  const photos = await lookupPhotos(context, view, extractPhotoIds([row.bodyMd]));
  return {
    ok: true,
    status: 201,
    body: toPostItem(member, row, view.locale, photos),
  };
}

/** `GET /api/v1/posts/:id` (R-BRD-04, R-BRD-06). */
export async function getPost(
  context: AppContext,
  viewer: Member,
  params: unknown,
  view: BodyView,
): Promise<AdminResult<PostItem>> {
  if (!can(viewer, 'content.read')) return denied;
  const path = parse(postIdSchema, params);
  if (!path.ok) return denied;
  const row = await findLivePost(context.database, path.data.id);
  if (!row) return denied;
  const photos = await lookupPhotos(context, view, extractPhotoIds([row.bodyMd]));
  return {
    ok: true,
    status: 200,
    body: toPostItem(viewer, row, view.locale, photos),
  };
}

/**
 * Loads a thread's post and a page of comments together with a single batched photo lookup
 * across `[post.bodyMd, ...comments.map(c => c.bodyMd)]` (R-BRD-04).
 */
export async function getThreadWithComments(
  context: AppContext,
  viewer: Member,
  params: unknown,
  query: unknown = {},
  view: BodyView,
): Promise<AdminResult<{ post: PostItem; comments: CommentPage }>> {
  if (!can(viewer, 'content.read')) return denied;
  const path = parse(postIdSchema, params);
  if (!path.ok) return denied;
  const parsedQuery = parse(commentListQuerySchema, query);
  if (!parsedQuery.ok) return parsedQuery;
  const after = parsedQuery.data.cursor ? decodeCommentCursor(parsedQuery.data.cursor) : null;
  if (parsedQuery.data.cursor && !after) {
    return { ok: false, code: 'validation', fields: { cursor: 'custom' } };
  }
  const postRow = await findLivePost(context.database, path.data.id);
  if (!postRow) return denied;
  const { rows: commentRows, more } = await listPostComments(context.database, {
    postId: postRow.id,
    after,
    limit: COMMENTS_PAGE,
  });
  const photoIds = extractPhotoIds([
    postRow.bodyMd,
    ...commentRows.filter((c) => c.deletedAt === null).map((c) => c.bodyMd),
  ]);
  const photos = await lookupPhotos(context, view, photoIds);
  const last = commentRows.at(-1);
  return {
    ok: true,
    status: 200,
    body: {
      post: toPostItem(viewer, postRow, view.locale, photos),
      comments: commentPageSchema.parse({
        items: commentRows.map((row) => toCommentItem(viewer, row, view.locale, photos)),
        nextCursor: more && last ? encodeCommentCursor(last) : null,
      }),
    },
  };
}

/** `PATCH /api/v1/posts/:id` (R-BRD-05, R-BRD-08). */
export async function editPost(
  context: AppContext,
  member: Member,
  params: unknown,
  input: unknown,
  view: BodyView,
  now = Date.now(),
): Promise<AdminResult<PostItem>> {
  const path = parse(postIdSchema, params);
  if (!path.ok) return denied;
  const row = await findLivePost(context.database, path.data.id);
  if (!row || !can(member, 'content.edit', { ownerId: row.authorId })) return denied;
  const parsed = parse(postPatchSchema, input);
  if (!parsed.ok) return parsed;
  if (
    (parsed.data.isPinned !== undefined || parsed.data.isLocked !== undefined) &&
    !can(member, 'thread.moderate')
  ) {
    return denied;
  }
  // A Save that sends the title and body back unchanged is no edit: no *edited* marker and
  // no admin `post.edit` audit row (R-BRD-08).
  const { title, body, ...flags } = parsed.data;
  const patch = {
    ...flags,
    ...(title !== undefined && title !== row.title ? { title } : {}),
    ...(body !== undefined && body !== row.bodyMd ? { body } : {}),
  };
  const updated =
    Object.keys(patch).length === 0
      ? row
      : await updateLivePost(context.database, row, member.id, patch, now);
  if (!updated) return denied;
  const photos = await lookupPhotos(context, view, extractPhotoIds([updated.bodyMd]));
  return {
    ok: true,
    status: 200,
    body: toPostItem(member, updated, view.locale, photos),
  };
}

/** `DELETE /api/v1/posts/:id` (R-BRD-08). */
export async function deletePost(
  context: AppContext,
  member: Member,
  params: unknown,
  now = Date.now(),
): Promise<AdminResult<{ ok: true }>> {
  const path = parse(postIdSchema, params);
  if (!path.ok) return denied;
  const row = await findLivePost(context.database, path.data.id);
  if (!row || !can(member, 'content.delete', { ownerId: row.authorId })) return denied;
  if (!(await softDeletePost(context.database, row, member.id, now))) return denied;
  return { ok: true, status: 200, body: discussionMutationResponseSchema.parse({ ok: true }) };
}

/** `GET /api/v1/posts/:id/comments?cursor=` (R-BRD-07, R-BRD-08, R-DB-07). */
export async function listComments(
  context: AppContext,
  viewer: Member,
  params: unknown,
  input: unknown,
  view: BodyView,
): Promise<AdminResult<CommentPage>> {
  if (!can(viewer, 'content.read')) return denied;
  const path = parse(postIdSchema, params);
  if (!path.ok) return denied;
  const parsed = parse(commentListQuerySchema, input);
  if (!parsed.ok) return parsed;
  const after = parsed.data.cursor ? decodeCommentCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !after) {
    return { ok: false, code: 'validation', fields: { cursor: 'custom' } };
  }
  const post = await findLivePost(context.database, path.data.id);
  if (!post) return denied;
  const { rows, more } = await listPostComments(context.database, {
    postId: post.id,
    after,
    limit: COMMENTS_PAGE,
  });
  const photoIds = extractPhotoIds(
    rows.filter((row) => row.deletedAt === null).map((row) => row.bodyMd),
  );
  const photos = await lookupPhotos(context, view, photoIds);
  const last = rows.at(-1);
  return {
    ok: true,
    status: 200,
    body: commentPageSchema.parse({
      items: rows.map((row) => toCommentItem(viewer, row, view.locale, photos)),
      nextCursor: more && last ? encodeCommentCursor(last) : null,
    }),
  };
}

/** `POST /api/v1/posts/:id/comments` (R-BRD-05, R-BRD-06, R-BRD-07, R-AUTH-21, R-DB-08). */
export async function createComment(
  context: AppContext,
  member: Member,
  params: unknown,
  input: unknown,
  view: BodyView,
  now = Date.now(),
): Promise<AdminResult<LiveComment>> {
  if (!can(member, 'content.create')) return denied;
  const path = parse(postIdSchema, params);
  if (!path.ok) return denied;
  const post = await findLivePost(context.database, path.data.id);
  if (!post) return denied;
  const parsed = parse(commentCreateSchema, input);
  if (!parsed.ok) return parsed;
  if (post.isLocked) return threadLocked;
  const taken = await takeRateLimit(context.database, 'post', member.id, now);
  if (!taken.ok) {
    return { ok: false, code: 'rate_limited', retryAfterSeconds: taken.retryAfterSeconds };
  }
  const outcome = await insertComment(context.database, post.id, member.id, parsed.data.body, now);
  if (outcome === 'locked') return threadLocked;
  if (outcome === 'not_found') return denied;
  await pushAfterCommit(context, 'reply', (ctx) =>
    sendItemPush(ctx, 'reply', {
      postId: post.id,
      threadTitle: post.title,
      actorId: member.id,
      actorName: member.displayName,
      priorityUserId: post.authorId,
      commentText: outcome.bodyMd,
      now,
    }),
  );
  const photos = await lookupPhotos(context, view, extractPhotoIds([outcome.bodyMd]));
  return {
    ok: true,
    status: 201,
    body: toCommentItem(member, outcome, view.locale, photos) as LiveComment,
  };
}

/**
 * R-BRD-07: the `?cursor=` of the comments page that starts at a live `comment`, or null
 * when it is on the first page.
 */
export async function commentPageCursor(
  context: AppContext,
  comment: Pick<LiveComment, 'postId' | 'createdAt' | 'id'>,
): Promise<string | null> {
  const before = await listCommentKeysBefore(context.database, {
    postId: comment.postId,
    before: comment,
    limit: COMMENTS_PAGE,
  });
  return before.length < COMMENTS_PAGE ? null : encodeCursor([before[0]!.createdAt, before[0]!.id]);
}

/** `PATCH /api/v1/comments/:id` (R-BRD-05, R-BRD-08). */
export async function editComment(
  context: AppContext,
  member: Member,
  params: unknown,
  input: unknown,
  view: BodyView,
  now = Date.now(),
): Promise<AdminResult<LiveComment>> {
  const path = parse(commentIdSchema, params);
  if (!path.ok) return denied;
  const row = await findLiveComment(context.database, path.data.id);
  if (!row || !can(member, 'content.edit', { ownerId: row.authorId })) return denied;
  const parsed = parse(commentPatchSchema, input);
  if (!parsed.ok) return parsed;
  const updated = await updateLiveComment(context.database, row, member.id, parsed.data.body, now);
  if (!updated) return denied;
  const photos = await lookupPhotos(context, view, extractPhotoIds([updated.bodyMd]));
  return {
    ok: true,
    status: 200,
    body: toCommentItem(member, updated, view.locale, photos) as LiveComment,
  };
}

/** `DELETE /api/v1/comments/:id` (R-BRD-08, R-DB-08). */
export async function deleteComment(
  context: AppContext,
  member: Member,
  params: unknown,
  now = Date.now(),
): Promise<AdminResult<{ ok: true }>> {
  const path = parse(commentIdSchema, params);
  if (!path.ok) return denied;
  const row = await findLiveComment(context.database, path.data.id);
  if (!row || !can(member, 'content.delete', { ownerId: row.authorId })) return denied;
  if (!(await softDeleteComment(context.database, row, member.id, now))) return denied;
  return { ok: true, status: 200, body: discussionMutationResponseSchema.parse({ ok: true }) };
}
