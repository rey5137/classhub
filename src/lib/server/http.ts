import type { Member } from './auth/membership';
import type { AppContext } from './context';
import { apiError } from './errors';
import type { AdminResult } from './services/admin';

/**
 * R-PLAT-01: a guarded route's member and adapters. The pipeline sets both before
 * any route runs; a route reached without them is a bug, so it fails closed.
 */
export function guarded(locals: App.Locals): { member: Member; context: AppContext } {
  if (!locals.member || !locals.context) throw new Error('route reached without the guard');
  return { member: locals.member, context: locals.context };
}

/** A body that is not JSON reads as `undefined`, which every schema refuses (`validation`). */
export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => undefined);
}

/** R-API-02: a service result as JSON, or the error shape with `Retry-After` on a 429. */
export function toResponse<T>(locals: App.Locals, result: AdminResult<T>): Response {
  if (result.ok) {
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return apiError(result.code, {
    requestId: locals.requestId,
    locale: locals.locale,
    ...(result.messageKey ? { messageKey: result.messageKey } : {}),
    ...(result.fields ? { fields: result.fields } : {}),
    ...(result.retryAfterSeconds
      ? { headers: { 'retry-after': String(result.retryAfterSeconds) } }
      : {}),
  });
}
