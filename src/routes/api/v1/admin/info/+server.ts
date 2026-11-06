import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { createInfo } from '$lib/server/services/info';

// §11.2 / R-BRD-02: create an info page (admins only, R-API-01).

export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await createInfo(
      context,
      member,
      await readJson(request),
      locals.settings.features,
      locals.locale,
    ),
  );
};
