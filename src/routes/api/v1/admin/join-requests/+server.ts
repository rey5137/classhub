import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { adminListJoinRequests } from '$lib/server/services/join';

// §11.2: pending join requests and whether the queue is full (admins only, R-AUTH-30).
export const GET: RequestHandler = async ({ locals }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await adminListJoinRequests(context, member));
};
