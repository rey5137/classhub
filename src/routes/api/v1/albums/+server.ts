import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { createAlbum, listAlbums } from '$lib/server/services/gallery';

export const GET: RequestHandler = async ({ locals }) => {
  const { member, context } = guarded(locals);
  const items = await listAlbums(context, member);
  return toResponse(locals, { ok: true, status: 200, body: { items } });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await createAlbum(context, member, await readJson(request)));
};
