import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { adminSendInviteEmail } from '$lib/server/services/invite-email';

// §11.2 / R-AUTH-31: email a pending invitee that they can now sign in (admins only).

export const POST: RequestHandler = async ({ locals, params, url }) => {
  const { member, context } = guarded(locals);
  const site = { name: locals.settings.name, origin: url.origin };
  return toResponse(locals, await adminSendInviteEmail(context, member, params.id, site));
};
