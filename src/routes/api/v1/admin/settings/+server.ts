import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { getSettings, updateSettings } from '$lib/server/services/settings';

// §11.2: the effective site settings · a partial update (admins only, R-API-01, R-UI-01).

export const GET: RequestHandler = async ({ locals }) => {
  const { member } = guarded(locals);
  return toResponse(locals, getSettings(member, locals.settings));
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await updateSettings(context, member, locals.settings, await readJson(request)),
  );
};
