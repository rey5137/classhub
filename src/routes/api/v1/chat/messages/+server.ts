import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { listChatMessages } from '$lib/server/services/chat';

// §11.2 / R-CHAT-10, 11, 17: history, 50 per page, `?before=` or `?after=` a message id.

export const GET: RequestHandler = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await listChatMessages(context, member, Object.fromEntries(url.searchParams)),
  );
};
