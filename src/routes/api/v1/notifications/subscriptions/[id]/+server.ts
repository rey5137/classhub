import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { unsubscribeDevice } from '$lib/server/services/notifications';

// §11.2 / R-NTF-08, 11: remove one of the member's own subscribed devices.

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await unsubscribeDevice(context, member, params.id, {
      featureEnabled: locals.settings.features.notifications,
    }),
  );
};
