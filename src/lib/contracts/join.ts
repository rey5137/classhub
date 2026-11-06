import { z } from 'zod';
import { displayNameSchema } from './admin';

/** `POST /join` (R-AUTH-27): the name becomes the invite's display name on approval. */
export const joinRequestSchema = z
  .object({
    name: displayNameSchema,
    email: z.string().trim().max(254).pipe(z.email()),
    note: z
      .string()
      .trim()
      .max(300)
      .refine((value) => !/\p{Cc}/u.test(value.replace(/\r?\n/g, ' ')), 'control characters'),
    // Turnstile's widget posts its token as `cf-turnstile-response`; the server verifies it.
    token: z.string().min(1).max(2048),
  })
  .strict();
export type JoinRequestInput = z.infer<typeof joinRequestSchema>;

/** `GET /api/v1/admin/join-requests` and the `/admin` queue card (R-AUTH-30). */
export interface JoinRequestView {
  id: string;
  name: string;
  email: string;
  note: string;
  createdAt: number;
}

export interface JoinQueue {
  items: JoinRequestView[];
  /** R-AUTH-29: the cap or the free seats are reached; `/join` shows its closed notice. */
  full: boolean;
}
