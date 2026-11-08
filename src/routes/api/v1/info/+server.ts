import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { listInfo } from '$lib/server/services/info';

// §11.2 / R-BRD-02: every info page, pinned first, for any member.

export const GET: RequestHandler = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await listInfo(context, member, Object.fromEntries(url.searchParams)));
};
