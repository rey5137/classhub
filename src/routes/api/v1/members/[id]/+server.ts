import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { getMemberProfile } from '$lib/server/services/profiles';

// §11.2: one member, projected for the viewer (R-PROF-04, R-PROF-13).
export const GET: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await getMemberProfile(context, member, params.id));
};
