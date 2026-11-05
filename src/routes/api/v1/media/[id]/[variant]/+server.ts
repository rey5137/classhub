import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { deliverMedia } from '$lib/server/services/media';

export const GET: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  const result = await deliverMedia(context, member, params, request);
  return result instanceof Response ? result : toResponse(locals, result);
};
