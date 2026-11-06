import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { listPhotos } from '$lib/server/services/gallery';

export const GET: RequestHandler = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await listPhotos(context, member, Object.fromEntries(url.searchParams)),
  );
};
