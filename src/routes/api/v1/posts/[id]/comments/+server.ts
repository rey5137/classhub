import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { createComment, listComments } from '$lib/server/services/discussions';

// §11.2 / R-BRD-07: list comments (`?cursor=`) and add a comment on an unlocked thread.

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await listComments(
      context,
      member,
      params,
      Object.fromEntries(url.searchParams),
      locals.locale,
    ),
  );
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await createComment(context, member, params, await readJson(request), locals.locale),
  );
};
