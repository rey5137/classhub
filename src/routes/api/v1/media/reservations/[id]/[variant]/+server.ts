import type { RequestHandler } from './$types';
import { mediaMimeSchema } from '$lib/contracts/media';
import { apiError } from '$lib/server/errors';
import { guarded, toResponse } from '$lib/server/http';
import { uploadVariant } from '$lib/server/services/media';

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  const { member, context } = guarded(locals);
  if (!mediaMimeSchema.safeParse(request.headers.get('content-type')).success)
    return apiError('validation', {
      requestId: locals.requestId,
      locale: locals.locale,
      status: 415,
    });
  return toResponse(locals, await uploadVariant(context, member, params, request));
};
