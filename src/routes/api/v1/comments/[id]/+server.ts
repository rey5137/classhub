import type { RequestHandler } from './$types';
import { bodyView, guarded, readJson, toResponse } from '$lib/server/http';
import { deleteComment, editComment } from '$lib/server/services/discussions';

// §11.2 / R-BRD-08: edit or soft-delete a comment (owner or admin).

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await editComment(context, member, params, await readJson(request), bodyView(locals)),
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await deleteComment(context, member, params));
};
