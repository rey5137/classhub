import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { editInfo, removeInfo } from '$lib/server/services/info';

// §11.2 / R-BRD-02: edit, pin and order · delete an info page (admins only, R-API-01).

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await editInfo(
      context,
      member,
      params,
      await readJson(request),
      locals.settings.features,
      locals.locale,
    ),
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await removeInfo(context, member, params));
};
