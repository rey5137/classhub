import { z } from 'zod';

// R-BRD-05, R-API-03, R-API-04: request and response DTOs for discussions.

export const postTitleSchema = z.string().trim().min(1).max(160);
export const postBodySchema = z.string().trim().min(1).max(10_000);
export const commentBodySchema = z.string().trim().min(1).max(2_000);

export const postIdSchema = z.object({ id: z.uuid() });
export const commentIdSchema = z.object({ id: z.uuid() });

export const postListQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const commentListQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const postCreateSchema = z
  .object({
    title: postTitleSchema,
    body: postBodySchema,
  })
  .strict();
export type PostCreateInput = z.infer<typeof postCreateSchema>;

export const postPatchSchema = z
  .object({
    title: postTitleSchema.optional(),
    body: postBodySchema.optional(),
    isPinned: z.boolean().optional(),
    isLocked: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'validation' });
export type PostPatchInput = z.infer<typeof postPatchSchema>;

export const commentCreateSchema = z
  .object({
    body: commentBodySchema,
  })
  .strict();
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;

export const commentPatchSchema = z
  .object({
    body: commentBodySchema,
  })
  .strict();
export type CommentPatchInput = z.infer<typeof commentPatchSchema>;

export const discussionAuthorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarMediaId: z.string().optional(),
});
export type DiscussionAuthor = z.infer<typeof discussionAuthorSchema>;

export const postSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  excerpt: z.string().max(200),
  isPinned: z.boolean(),
  isLocked: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastActivityAt: z.number().int(),
  edited: z.boolean(),
  author: discussionAuthorSchema,
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canModerate: z.boolean(),
});
export type PostSummary = z.infer<typeof postSummarySchema>;

export const postItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  bodyMd: z.string(),
  bodyHtml: z.string(),
  isPinned: z.boolean(),
  isLocked: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastActivityAt: z.number().int(),
  edited: z.boolean(),
  author: discussionAuthorSchema,
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canModerate: z.boolean(),
});
export type PostItem = z.infer<typeof postItemSchema>;

export const postPageSchema = z.object({
  items: z.array(postSummarySchema),
  nextCursor: z.string().nullable(),
});
export type PostPage = z.infer<typeof postPageSchema>;

export const liveCommentSchema = z.object({
  id: z.uuid(),
  postId: z.uuid(),
  deleted: z.literal(false),
  bodyMd: z.string(),
  bodyHtml: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  edited: z.boolean(),
  author: discussionAuthorSchema,
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});
export type LiveComment = z.infer<typeof liveCommentSchema>;

export const deletedCommentStubSchema = z.object({
  id: z.uuid(),
  postId: z.uuid(),
  deleted: z.literal(true),
  createdAt: z.number().int(),
});
export type DeletedCommentStub = z.infer<typeof deletedCommentStubSchema>;

export const commentItemSchema = z.discriminatedUnion('deleted', [
  liveCommentSchema,
  deletedCommentStubSchema,
]);
export type CommentItem = z.infer<typeof commentItemSchema>;

export const commentPageSchema = z.object({
  items: z.array(commentItemSchema),
  nextCursor: z.string().nullable(),
});
export type CommentPage = z.infer<typeof commentPageSchema>;

export const discussionMutationResponseSchema = z.object({ ok: z.literal(true) });
