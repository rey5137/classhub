import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { createReservation } from '$lib/server/services/media';

export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await createReservation(context, member, await readJson(request)));
};
