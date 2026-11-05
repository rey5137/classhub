import { z } from 'zod';
import { siteConfig } from '../config';

export const mediaVariantSchema = z.enum(['image', 'thumb']);
export type MediaVariant = z.infer<typeof mediaVariantSchema>;
export const mediaPathSchema = z.object({ id: z.uuid(), variant: mediaVariantSchema });
export const reservationPathSchema = z.object({ id: z.uuid() });
export const mediaMimeSchema = z.enum(['image/webp', 'image/jpeg']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
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
  });
export type ReservationInput = z.infer<typeof reservationSchema>;

export const completeSchema = z
  .object({
    caption: z.string().max(500).optional(),
    albumId: z.uuid().optional(),
    takenYear: z.number().int().min(1000).max(9999).optional(),
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
