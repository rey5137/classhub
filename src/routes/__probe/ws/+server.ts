import type { RequestHandler } from './$types';
import { apiError } from '$lib/server/errors';
import { guarded } from '$lib/server/http';

// TEMPORARY (R-OPS-16, remove in slice 4a): the 1d WebSocket-through-Access probe.
// The pipeline has already verified the Access identity, the active membership,
// the unlocked site and the upgrade's Origin; without WS_PROBE=1 this is a 404.

export const GET: RequestHandler = async ({ locals, request }) => {
  const { context } = guarded(locals);
  const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (!context.wsProbe || !upgrade) {
    return apiError('not_found', { requestId: locals.requestId, locale: locals.locale });
  }
  return context.wsProbe(request);
};
