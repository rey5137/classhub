import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { finishReservation } from '$lib/server/services/media';

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await finishReservation(context, member, params, await readJson(request)),
  );
};
