import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { adminPatchMember } from '$lib/server/services/admin';

// §11.2: role, suspend, reactivate, complete deletion (R-PROF-11).
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await adminPatchMember(context, member, params.id, await readJson(request)),
  );
};
