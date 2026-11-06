import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { deletePost, editPost, getPost } from '$lib/server/services/discussions';

// §11.2 / R-BRD-06, R-BRD-08: read, edit/moderate (owner/admin; pin and lock admin) and delete a thread.

export const GET: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await getPost(context, member, params, locals.locale));
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await editPost(context, member, params, await readJson(request), locals.locale),
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await deletePost(context, member, params));
};
