import { z } from 'zod';

/** R-API-02: the stable error codes; clients branch on these, never on `message`. */
export const errorCodes = [
  'unauthenticated',
  'forbidden',
  'locked',
  'not_found',
  'validation',
  'rate_limited',
  'storage_full',
  'feature_disabled',
  'conflict',
  'payload_too_large',
  'unavailable',
  'internal',
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
