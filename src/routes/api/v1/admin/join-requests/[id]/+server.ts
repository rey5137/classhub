import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { adminApproveJoinRequest, adminRejectJoinRequest } from '$lib/server/services/join';

// §11.2: approve runs the invite path; reject deletes (admins only, R-AUTH-30).

export const POST: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await adminApproveJoinRequest(context, member, params.id));
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await adminRejectJoinRequest(context, member, params.id));
};
