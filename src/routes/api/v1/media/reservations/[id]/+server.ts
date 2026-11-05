import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { abandonReservation } from '$lib/server/services/media';

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await abandonReservation(context, member, params));
};
