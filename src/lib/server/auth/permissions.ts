import type { Member } from './membership';

// R-NAV-05: every route asks here; Svelte only hides what these refuse. One rule per
// §3.3 matrix row, keyed by the action names routes use (`can(member, 'post.delete', post)`).

export type ContactVisibility = 'private' | 'admins' | 'members';

/** A resource someone owns: a thread, comment, photo, chat message or album. */
export interface Owned {
  ownerId: string;
}

const isAdmin = (member: Member) => member.role === 'admin';
const ownsOrAdmin = (member: Member, resource: Owned) =>
  resource.ownerId === member.id || isAdmin(member);

const rules = {
  // Read home, memories, board, chat, directory: any active member.
  'content.read': () => true,
  // Edit own profile, contacts, visibility, avatar.
  'profile.edit': () => true,
  // See another member's contact field (§4): `members` for everyone, `admins` for admins.
  'contact.view': (member: Member, field: { ownerId: string; visibility: ContactVisibility }) =>
    field.ownerId === member.id ||
    field.visibility === 'members' ||
    (field.visibility === 'admins' && isAdmin(member)),
  // Create thread, comment, chat message, upload photo (rate limits and quota apply elsewhere).
  'content.create': () => true,
  // Edit/delete own content; an admin may edit or delete anyone's.
  'content.edit': ownsOrAdmin,
  'content.delete': ownsOrAdmin,
  // Pin or lock a thread.
  'thread.moderate': isAdmin,
  'album.create': () => true,
  'album.edit': ownsOrAdmin,
  // Invite, revoke, suspend, reactivate, change role.
  'members.manage': isAdmin,
  // Info pages, site settings, theme, feature flags.
  'settings.edit': isAdmin,
  // Usage, backup and archive status.
  'usage.view': isAdmin,
  'data.exportOwn': () => true,
  // Everyone's chat or contacts: CLI only (§13), never through the app.
  'data.exportAll': () => false,
} satisfies Record<string, (member: Member, resource: never) => boolean>;

export type Action = keyof typeof rules;
type ResourceOf<A extends Action> = Parameters<(typeof rules)[A]>[1];

export const ACTIONS = Object.keys(rules) as Action[];

/** `member` is the active member from `locals.member`; nobody else reaches a route. */
export function can<A extends Action>(
  member: Member,
  action: A,
  ...resource: ResourceOf<A> extends undefined ? [] : [ResourceOf<A>]
): boolean {
  const rule = rules[action] as (member: Member, resource?: unknown) => boolean;
  return rule(member, resource[0]);
}
