import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { editAlbum } from '$lib/server/services/gallery';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await editAlbum(context, member, params, await readJson(request)));
};
