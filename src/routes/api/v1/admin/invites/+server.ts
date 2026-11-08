import type { RequestHandler } from './$types';
import { guarded, readJson, toResponse } from '$lib/server/http';
import { adminCreateInvite, adminListInvites, adminRevokeInvite } from '$lib/server/services/admin';

// §11.2: list with Access sync status · invite · revoke (admins only, R-API-01).

export const GET: RequestHandler = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  return toResponse(
    locals,
    await adminListInvites(context, member, Object.fromEntries(url.searchParams)),
  );
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await adminCreateInvite(context, member, await readJson(request)));
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
  const { member, context } = guarded(locals);
  return toResponse(locals, await adminRevokeInvite(context, member, await readJson(request)));
};
