import { z } from 'zod';

const role = z.enum(['member', 'admin']);

/** R-PROF-01: 1–80 characters after trimming, no control characters. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/\p{Cc}/u.test(value), 'control characters are not allowed');

/** `POST /api/v1/admin/invites` (R-AUTH-08); the email is normalized by the service. */
export const inviteCreateSchema = z
  .object({
    email: z.string().trim().max(254).pipe(z.email()),
    displayName: displayNameSchema,
    role: role.default('member'),
  })
  .strict();

/** `DELETE /api/v1/admin/invites`: revoke one invite by id. */
export const inviteRevokeSchema = z.object({ id: z.string().min(1).max(64) }).strict();

/** `PATCH /api/v1/admin/members/:id`: one change per request. */
export const memberPatchSchema = z.union([
  z.object({ role }).strict(),
  z.object({ status: z.enum(['active', 'suspended']) }).strict(),
  // R-PROF-11: complete the member's standing deletion request.
  z.object({ deletion: z.literal('complete') }).strict(),
]);

export const inviteViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  role,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  userId: z.string().nullable(),
  userStatus: z.enum(['invited', 'active', 'suspended']).nullable(),
  displayName: z.string().nullable(),
  /** R-PROF-11: a standing deletion request, shown to admins. */
  deletionRequestedAt: z.number().nullable(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  accessSyncedAt: z.number().nullable(),
});

export const INVITES_PAGE = 50;

export const invitesQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(INVITES_PAGE).default(INVITES_PAGE),
  })
  .strict();

/** `GET /api/v1/admin/invites` (R-AUTH-10, R-AUTH-19). */
export const inviteListSchema = z.object({
  items: z.array(inviteViewSchema),
  nextCursor: z.string().nullable(),
  seats: z.object({ used: z.number(), warnAt: z.number(), limit: z.number() }),
});
export type InviteList = z.infer<typeof inviteListSchema>;
