import type { RequestHandler } from './$types';
import { apiError } from '$lib/server/errors';
import { guarded } from '$lib/server/http';

// §9.2 / R-CHAT-04: the chat socket. The pipeline has already verified the Access
// identity, the active membership, the upgrade's Origin, the unlocked site and the chat
// flag; only then does the hub build the internal request to the room.

export const GET: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  const errorContext = { requestId: locals.requestId, locale: locals.locale };
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !locals.authUntil) {
    return apiError('not_found', errorContext);
  }
  try {
    return await context.realtime.connect(request, {
      id: member.id,
      role: member.role,
      displayName: member.displayName,
      authUntil: locals.authUntil,
    });
  } catch {
    // No context key or no room binding: the socket cannot be authorized (fail closed).
    return apiError('unavailable', errorContext);
  }
};
