import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { getOwnProfile, updateOwnProfile } from '$lib/server/services/profiles';

// §11.2: the current member's own full profile · update names, contacts and visibility.

export const GET: RequestHandler = async ({ locals }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await getOwnProfile(context, member));
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await updateOwnProfile(context, member, await readJson(request)));
};
