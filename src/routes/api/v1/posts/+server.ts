import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { createPost, listPosts } from '$lib/server/services/discussions';

// §11.2 / R-BRD-05, R-BRD-06: board list (`?cursor=`) and thread creation.

export const GET: RequestHandler = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await listPosts(context, member, Object.fromEntries(url.searchParams)));
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await createPost(context, member, await readJson(request), locals.locale),
  );
};
