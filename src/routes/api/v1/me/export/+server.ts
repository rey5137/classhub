import type { RequestHandler } from './$types';
import { guarded, toResponse } from '$lib/server/http';
import { exportOwnData } from '$lib/server/services/profiles';

// §11.2 / R-PROF-09: the requester's own data, as a file download.
export const GET: RequestHandler = async ({ locals }) => {
  const { member, context } = guarded(locals);
  const response = toResponse(locals, await exportOwnData(context, member));
  if (response.ok) {
    response.headers.set('content-disposition', 'attachment; filename="classhub-my-data.json"');
  }
  return response;
};
