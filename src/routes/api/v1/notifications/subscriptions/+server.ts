import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { subscribeDevice } from '$lib/server/services/notifications';

// §11.2 / R-NTF-08, 10: store or refresh this device's Web Push subscription.

export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await subscribeDevice(context, member, await readJson(request), {
      featureEnabled: locals.settings.features.notifications,
      defaultLocale: locals.locale,
      userAgent: request.headers.get('user-agent'),
    }),
  );
};
