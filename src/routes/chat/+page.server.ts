import type { PageServerLoad } from './$types';
import { can } from '$lib/server/auth/permissions';
import { requireFeature } from '$lib/server/features';
import { guarded } from '$lib/server/http';

// §9.3: the page needs only who is reading; the messages come from the history route
// and the socket in the browser (R-CHAT-10), so nothing here goes stale.
export const load: PageServerLoad = ({ locals }) => {
  requireFeature(locals, 'chat');
  const { member } = guarded(locals);
  return {
    viewerId: member.id,
    // R-CHAT-03: an admin may delete any message; others only their own.
    deleteAny: can(member, 'content.delete', { ownerId: '' }),
  };
};
