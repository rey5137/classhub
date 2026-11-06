import { z } from 'zod';

// R-BRD-02: admin-edited class info pages, reachable at `/info/[slug]`.

export const infoSlugSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const title = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !/\p{Cc}/u.test(value), 'control characters are not allowed');
/** Markdown, rendered by the sanitizing renderer (R-BRD-03); `bodyHtml` is never stored. */
const body = z.string().max(20_000);
const sortOrder = z.number().int().min(-9999).max(9999);

/** `POST /api/v1/admin/info`. */
export const infoCreateSchema = z
  .object({
    slug: infoSlugSchema,
    title,
    body: body.default(''),
    isPinned: z.boolean().default(false),
    sortOrder: sortOrder.default(0),
  })
  .strict();
export type InfoCreate = z.infer<typeof infoCreateSchema>;

/** `PATCH /api/v1/admin/info/:id`: only the keys sent change. */
export const infoPatchSchema = z
  .object({ slug: infoSlugSchema, title, body, isPinned: z.boolean(), sortOrder })
  .partial()
  .strict();
export type InfoPatch = z.infer<typeof infoPatchSchema>;

export const infoIdSchema = z.object({ id: z.uuid() });
export const infoSlugParamsSchema = z.object({ slug: infoSlugSchema });

export const infoSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  isPinned: z.boolean(),
  sortOrder: z.number().int(),
  updatedAt: z.number().int(),
});
export type InfoSummary = z.infer<typeof infoSummarySchema>;

/** `GET /api/v1/info`: pinned first, then `sort_order`, then title (R-API-03 shape; one page). */
export const infoListSchema = z.object({
  items: z.array(infoSummarySchema),
  nextCursor: z.null(),
});
export type InfoList = z.infer<typeof infoListSchema>;

export const infoPageSchema = infoSummarySchema.extend({
  bodyMd: z.string(),
  bodyHtml: z.string(),
});
export type InfoPage = z.infer<typeof infoPageSchema>;

export const infoMutationResponseSchema = z.object({ ok: z.literal(true) });
