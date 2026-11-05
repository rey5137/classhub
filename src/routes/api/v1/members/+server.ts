import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { listMembers } from '$lib/server/services/profiles';

// §11.2 / R-PROF-08: the directory of active members, `?q=&cursor=`.
export const GET: RequestHandler = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await listMembers(context, member, Object.fromEntries(url.searchParams)),
  );
};
