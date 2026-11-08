import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { createAlbum, listAlbumsPage } from '$lib/server/services/gallery';

export const GET: RequestHandler = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await listAlbumsPage(context, member, Object.fromEntries(url.searchParams)),
  );
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await createAlbum(context, member, await readJson(request)));
};
