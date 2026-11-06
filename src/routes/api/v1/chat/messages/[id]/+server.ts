import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { deleteChatMessage } from '$lib/server/services/chat';

// §11.2 / R-CHAT-03: tombstone a message (sender or admin).

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await deleteChatMessage(context, member, params));
};
