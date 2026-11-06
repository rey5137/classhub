import { z } from 'zod';
import { siteConfig } from '../config';

export const mediaVariantSchema = z.enum(['image', 'thumb']);
export type MediaVariant = z.infer<typeof mediaVariantSchema>;
export const mediaPathSchema = z.object({ id: z.uuid(), variant: mediaVariantSchema });
export const reservationPathSchema = z.object({ id: z.uuid() });
export const mediaMimeSchema = z.enum(['image/webp', 'image/jpeg']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** R-MEM-13: a 512 px avatar is far under this; it bounds what a member can park in the quota. */
export const avatarMaxBytes = 1_048_576;
const year = z.number().int().min(1000).max(9999);
const bytes = z.number().int().nonnegative().max(siteConfig.uploads.maxImageBytes);

export const reservationSchema = z
  .object({
    purpose: z.enum(['photo', 'avatar', 'site']),
    imageBytes: bytes.min(1),
    thumbBytes: bytes,
    sha256: hash,
    thumbSha256: hash,
    mimeType: mediaMimeSchema,
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.purpose === 'avatar'
        ? value.thumbBytes !== 0 || value.width !== 512 || value.height !== 512
        : value.thumbBytes === 0
    )
      ctx.addIssue({ code: 'custom', path: ['thumbBytes'], message: 'validation' });
    if (value.purpose === 'avatar' && value.imageBytes > avatarMaxBytes)
      ctx.addIssue({ code: 'custom', path: ['imageBytes'], message: 'validation' });
  });
export type ReservationInput = z.infer<typeof reservationSchema>;

export const completeSchema = z
  .object({
    caption: z.string().max(500).optional(),
    albumId: z.uuid().optional(),
    takenYear: year.optional(),
  })
  .strict();
export type CompleteInput = z.infer<typeof completeSchema>;
export const reservationResponseSchema = z.object({
  id: z.uuid(),
  mediaId: z.uuid(),
  expiresAt: z.number().int(),
});
export const mediaCompleteResponseSchema = z.object({ id: z.uuid() });
export const mediaMutationResponseSchema = z.object({ ok: z.literal(true) });

// R-MEM-14: albums, the gallery page and a photo's own edits.
const albumName = z.string().trim().min(1).max(80);
const albumDescription = z.string().trim().max(500);
export const albumCreateSchema = z
  .object({
    name: albumName,
    yearTag: year.nullable().optional(),
    description: albumDescription.nullable().optional(),
  })
  .strict();
export const albumPatchSchema = albumCreateSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'validation' });
export type AlbumPatch = z.infer<typeof albumPatchSchema>;
export const mediaIdSchema = z.object({ id: z.uuid() });
export const galleryQuerySchema = z
  .object({
    album: z.uuid().optional(),
    year: z.coerce.number().pipe(year).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export const mediaPatchSchema = z
  .object({
    caption: z.string().trim().max(500).nullable().optional(),
    albumId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'validation' });
export type MediaPatch = z.infer<typeof mediaPatchSchema>;

export const albumSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  yearTag: z.number().int().nullable(),
  description: z.string().nullable(),
  canEdit: z.boolean(),
});
export type Album = z.infer<typeof albumSchema>;
export const uploaderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarMediaId: z.string().optional(),
});
export const galleryItemSchema = z.object({
  id: z.uuid(),
  caption: z.string().nullable(),
  album: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  year: z.number().int().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  createdAt: z.number().int(),
  uploader: uploaderSchema,
  canEdit: z.boolean(),
});
export type GalleryItem = z.infer<typeof galleryItemSchema>;
export const galleryPageSchema = z.object({
  items: z.array(galleryItemSchema),
  nextCursor: z.string().nullable(),
});
export type GalleryPage = z.infer<typeof galleryPageSchema>;
