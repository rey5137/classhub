import {
  DEFAULT_VISIBILITY,
  parseVisibility,
  type ProfileField,
  type PublicProfile,
  type VisibilityMap,
} from '../../contracts/profile';
import { siteConfig } from '../../config';
import { emailHref, normalizeMessagingUrl, phoneHref } from '../../shared/contacts';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { UserStatus } from '../repositories/users';

/** One member's stored profile: the `users` columns and their `profile_contacts` row. */
export interface ProfileOwner {
  id: string;
  displayName: string;
  status: UserStatus;
  preferredName: string | null;
  avatarMediaId: string | null;
  deletionRequestedAt: number | null;
  contacts: {
    contactEmail: string | null;
    phone: string | null;
    messagingUrl: string | null;
    city: string | null;
    bio: string | null;
    visibilityJson: string;
  } | null;
}

export type Viewer = Member;

/** The ways to reach someone (AC-PROF-03's list); a pending deletion hides these at once. */
const CONTACT_FIELDS: ReadonlySet<ProfileField> = new Set([
  'contact_email',
  'phone',
  'messaging_url',
  'city',
]);

/** R-PROF-02/03: a member who never saved a profile shows the defaults; a saved map rules after. */
export function visibilityOf(owner: Pick<ProfileOwner, 'contacts'>): VisibilityMap {
  return owner.contacts ? parseVisibility(owner.contacts.visibilityJson) : DEFAULT_VISIBILITY;
}

/**
 * R-PROF-04: the one projection every member payload goes through (INV-5). Each field
 * is copied only when `contact.view` allows it, so a hidden field never exists on the
 * result. A non-active owner shows only the name; a pending deletion request hides
 * the contact fields from everyone but the owner (R-PROF-13). `auth_email` is not an
 * input, so it can never leave through here (R-PROF-05).
 */
export function projectProfile(viewer: Viewer, owner: ProfileOwner): PublicProfile {
  const profile: PublicProfile = { id: owner.id, displayName: owner.displayName };
  const self = viewer.id === owner.id;
  if (owner.status !== 'active' && !self) return profile;
  const withdrawn = owner.deletionRequestedAt !== null && !self;

  const visibility = visibilityOf(owner);
  const shown = (field: ProfileField) =>
    !(withdrawn && CONTACT_FIELDS.has(field)) &&
    can(viewer, 'contact.view', { ownerId: owner.id, visibility: visibility[field] });
  const contacts = owner.contacts;

  if (owner.preferredName && shown('preferred_name')) profile.preferredName = owner.preferredName;
  if (owner.avatarMediaId && shown('avatar_media_id')) profile.avatarMediaId = owner.avatarMediaId;
  if (!contacts) return profile;
  if (contacts.bio && shown('bio')) profile.bio = contacts.bio;
  if (contacts.city && shown('city')) profile.city = contacts.city;
  if (contacts.contactEmail && shown('contact_email')) {
    profile.contactEmail = { text: contacts.contactEmail, href: emailHref(contacts.contactEmail) };
  }
  if (contacts.phone && shown('phone')) {
    profile.phone = { text: contacts.phone, href: phoneHref(contacts.phone) };
  }
  // Re-checked on the way out too: a restored or hand-edited row never becomes a live href.
  const url = contacts.messagingUrl
    ? normalizeMessagingUrl(contacts.messagingUrl, siteConfig.messagingHosts)
    : null;
  if (url && shown('messaging_url')) profile.messagingUrl = { text: url, href: url };
  return profile;
}
