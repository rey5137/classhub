import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { getNotifications, patchNotifications } from '$lib/server/services/notifications';

// §11.2 / R-NTF-07, 09, 11: own kinds, mute, devices (labels only) and VAPID public key.

export const GET: RequestHandler = async ({ locals }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await getNotifications(context, member, {
      featureEnabled: locals.settings.features.notifications,
      timeZone: locals.timeZone,
      defaultLocale: locals.locale,
    }),
  );
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await patchNotifications(context, member, await readJson(request), {
      featureEnabled: locals.settings.features.notifications,
      timeZone: locals.timeZone,
      defaultLocale: locals.locale,
    }),
  );
};
