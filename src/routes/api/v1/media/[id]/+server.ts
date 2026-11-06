import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { deletePhoto, editPhoto } from '$lib/server/services/gallery';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await editPhoto(context, member, params, await readJson(request), locals.settings.features),
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await deletePhoto(context, member, params, locals.settings.features));
};
