import { z } from 'zod';
import { siteConfig } from '../config';
import { normalizeMessagingUrl, normalizePhone } from '../shared/contacts';
import { displayNameSchema } from './admin';

// §4: the profile DTOs. Visibility is keyed by the spec's field names, the same keys
// `profile_contacts.visibility_json` stores and `site.config.ts` lists.

export const visibilitySchema = z.enum(['private', 'admins', 'members']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const PROFILE_FIELDS = [
  'preferred_name',
  'contact_email',
  'phone',
  'messaging_url',
  'city',
  'bio',
  'avatar_media_id',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type VisibilityMap = Record<ProfileField, Visibility>;

/** R-PROF-02: what a member who never changed a setting shows (AC-PROF-03). */
export const DEFAULT_VISIBILITY: VisibilityMap = {
  preferred_name: 'members',
  contact_email: 'private',
  phone: 'private',
  messaging_url: 'private',
  city: 'private',
  bio: 'members',
  avatar_media_id: 'members',
};

/** R-PROF-03: a stored map; an unknown, missing or invalid value reads as `private`. */
const storedVisibilitySchema = z.object(
  Object.fromEntries(PROFILE_FIELDS.map((field) => [field, visibilitySchema.catch('private')])) as {
    [K in ProfileField]: z.ZodCatch<typeof visibilitySchema>;
  },
);

export function parseVisibility(json: string): VisibilityMap {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    value = {};
  }
  const map = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return storedVisibilitySchema.parse(map);
}

const CONTROL = /\p{Cc}/u;
// A bio keeps its line breaks; every other control character is refused.
const CONTROL_BUT_NEWLINE = /[^\P{Cc}\n]/u;

/** `''` or `null` clears a field (R-PROF-10). */
const cleared = z.union([z.null(), z.string().trim().length(0)]).transform(() => null);
const clearable = <T extends z.ZodType>(schema: T) => z.union([cleared, schema]).optional();

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !CONTROL.test(value), 'control characters are not allowed');

/** `PATCH /api/v1/me` (R-PROF-01, 02, 06): every field optional, contacts normalized. */
export const profilePatchSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    preferredName: clearable(line(80)),
    contactEmail: clearable(z.string().trim().max(254).pipe(z.email())),
    phone: clearable(
      z
        .string()
        .refine((value) => normalizePhone(value) !== null, 'not a phone number')
        .transform((value) => normalizePhone(value) ?? ''),
    ),
    messagingUrl: clearable(
      z
        .string()
        .refine(
          (value) => normalizeMessagingUrl(value, siteConfig.messagingHosts) !== null,
          'not an allow-listed https link',
        )
        .transform((value) => normalizeMessagingUrl(value, siteConfig.messagingHosts) ?? ''),
    ),
    city: clearable(line(80)),
    bio: clearable(
      z
        .string()
        .trim()
        .max(500)
        .refine((value) => !CONTROL_BUT_NEWLINE.test(value), 'control characters are not allowed'),
    ),
    // R-MEM-13: the id of one of the caller's own avatar pictures, or null to remove it.
    avatarMediaId: z.uuid().nullable().optional(),
    visibility: z
      .object(
        Object.fromEntries(PROFILE_FIELDS.map((field) => [field, visibilitySchema.optional()])) as {
          [K in ProfileField]: z.ZodOptional<typeof visibilitySchema>;
        },
      )
      .strict()
      .optional(),
  })
  .strict();
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/** `GET /api/v1/members?q=&cursor=` (R-PROF-08). */
export const directoryQuerySchema = z
  .object({ q: z.string().max(80).optional(), cursor: z.string().max(512).optional() })
  .strict();

/** `POST /api/v1/me/deletion-request` (R-PROF-11): keep or delete my content. */
export const deletionRequestSchema = z.object({ keepContent: z.boolean() }).strict();

/** A contact rendered as a link; the href is built from the normalized value only. */
export interface ContactLink {
  text: string;
  href: string;
}

/**
 * R-PROF-04: one member as a viewer may see them. A field the viewer may not see is
 * absent, never null, so it cannot be serialized by mistake.
 */
export interface PublicProfile {
  id: string;
  displayName: string;
  preferredName?: string;
  avatarMediaId?: string;
  bio?: string;
  city?: string;
  contactEmail?: ContactLink;
  phone?: ContactLink;
  messagingUrl?: ContactLink;
}

/** `GET /api/v1/me`: the owner's full profile plus what only the owner sees (R-PROF-05). */
export interface OwnProfile {
  profile: PublicProfile;
  authEmail: string;
  role: 'member' | 'admin';
  visibility: VisibilityMap;
  deletionRequestedAt: number | null;
  deletionKeepContent: boolean;
}

/**
 * A directory row: the projection cut to what a list shows, so the directory is no bulk
 * contact listing (R-PROF-08); the rest is on `/members/[id]`.
 */
export type DirectoryEntry = Pick<
  PublicProfile,
  'id' | 'displayName' | 'preferredName' | 'avatarMediaId' | 'city'
>;

export interface DirectoryPage {
  items: DirectoryEntry[];
  nextCursor: string | null;
}
