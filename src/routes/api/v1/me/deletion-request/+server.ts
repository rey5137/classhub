import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { requestDeletion } from '$lib/server/services/profiles';

// §11.2 / R-PROF-11: record the member's deletion request; an admin completes it.
export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await requestDeletion(context, member, await readJson(request)));
};
