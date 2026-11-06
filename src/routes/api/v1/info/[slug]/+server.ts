import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { getInfo } from '$lib/server/services/info';

// §11.2 / R-BRD-02: one info page with its rendered body.

export const GET: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await getInfo(context, member, params, locals.settings.features, locals.locale),
  );
};
