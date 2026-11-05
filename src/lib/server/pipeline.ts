import type { Handle, HandleServerError, RequestEvent } from '@sveltejs/kit';
import { normalizeEmail, resolveMember } from './auth/membership';
import { isBootstrapAdmin, readSetupUnlocked } from './repositories/settings';
import type { AppContext } from './context';
import { apiError } from './errors';
import { securityHeaders, staticCsp, withStyleNonce } from './headers';
import { uuidv7 } from './ids';
import { IdentityError } from './ports/identity';
import { logLine, redact, resolveLogSalt, saltedHash, type LogFields } from './log';

/** R-AUTH-22: JSON and form bodies; uploads (R-MEM-08) and chat frames have their own bounds. */
export const JSON_BODY_LIMIT = 64 * 1024;
export const DENIED_PATH = '/denied';
export const LOCKED_PATH = '/locked';
export const SETUP_PATH = '/admin/setup';

// R-API-01: everything else, and any other method on these, needs a verified identity and an active membership.
const PUBLIC_PATHS = new Set(['/health', DENIED_PATH, LOCKED_PATH]);
const PUBLIC_METHODS = new Set(['GET', 'HEAD']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// R-MEM-08: the streamed upload (PUT only) is bounded by the media limits in its own route.
const UPLOAD_ROUTE = /^\/api\/v1\/media\/reservations\/[^/]+\/[^/]+$/;

export interface PipelineOptions {
  getContext(event: RequestEvent): Promise<AppContext>;
  /** A production build warns once when `LOG_HASH_SALT` is unset. */
  production: boolean;
}

function pathOf(event: RequestEvent): string {
  return event.url.pathname.replace(/\/+$/, '') || '/';
}

function isUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function clientAddress(event: RequestEvent): string {
  try {
    return event.getClientAddress();
  } catch {
    return '';
  }
}

function isNavigation(event: RequestEvent): boolean {
  const { method } = event.request;
  return (
    (method === 'GET' || method === 'HEAD') &&
    !pathOf(event).startsWith('/api/') &&
    !isUpgrade(event.request)
  );
}

/** A page is sent to `location`; SvelteKit's data request gets the same redirect as JSON. */
function redirectOr(event: RequestEvent, location: string, otherwise: () => Response): Response {
  if (event.isDataRequest) {
    return new Response(JSON.stringify({ type: 'redirect', location }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (isNavigation(event)) return new Response(null, { status: 303, headers: { location } });
  return otherwise();
}

/**
 * R-AUTH-11: one response per request kind, whatever the cause: a navigation
 * is sent to /denied, SvelteKit's data request gets the same redirect as JSON,
 * and everything else (API, upgrade, form post) gets `403 forbidden`.
 */
function deny(event: RequestEvent): Response {
  return redirectOr(event, DENIED_PATH, () =>
    apiError('forbidden', { requestId: event.locals.requestId, locale: event.locals.locale }),
  );
}

/** R-AUTH-12: while locked every page shows /locked and every API answers `423 locked`. */
function locked(event: RequestEvent): Response {
  return redirectOr(event, LOCKED_PATH, () =>
    apiError('locked', { requestId: event.locals.requestId, locale: event.locals.locale }),
  );
}

function isJson(contentType: string | null): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType ?? '');
}

/** Reads at most `limit` bytes; null when the body is larger. */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** R-AUTH-22 and R-AUTH-17: bound the body before anything parses it; JSON APIs take JSON only. */
async function boundBody(event: RequestEvent): Promise<Response | null> {
  const { request } = event;
  const path = pathOf(event);
  if (!MUTATING.has(request.method)) return null;
  if (request.method === 'PUT' && UPLOAD_ROUTE.test(path)) return null;
  const options = { requestId: event.locals.requestId, locale: event.locals.locale };

  const declared = request.headers.get('content-length');
  const length = declared === null ? null : Number(declared);
  if (length !== null && !(length <= JSON_BODY_LIMIT)) {
    return apiError('payload_too_large', options);
  }
  if (request.body === null) return null;
  const wrongType = path.startsWith('/api/') && !isJson(request.headers.get('content-type'));
  if (wrongType && length !== 0) return apiError('validation', { ...options, status: 415 });
  // A declared length is only an early refusal: the bytes are counted as they
  // arrive, so a chunked or understated body is cut off at the limit too.
  const bytes = await readCapped(request.body, JSON_BODY_LIMIT);
  if (!bytes) return apiError('payload_too_large', options);
  if (wrongType && bytes.byteLength > 0) return apiError('validation', { ...options, status: 415 });
  const headers = new Headers(request.headers);
  headers.set('content-length', String(bytes.byteLength));
  event.request = new Request(request.url, {
    method: request.method,
    headers,
    body: bytes,
    signal: request.signal,
  });
  return null;
}

/** R-AUTH-20: every response, including denials and errors. */
function finalize(event: RequestEvent, original: Response): Response {
  let response = original;
  try {
    response.headers.set('x-request-id', event.locals.requestId);
  } catch {
    // Immutable headers (Response.redirect, a fetched response): copy, unless it is an upgrade.
    if (response.status === 101) return response;
    response = new Response(response.body, response);
    response.headers.set('x-request-id', event.locals.requestId);
  }
  const { headers } = response;
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  const csp = headers.get('content-security-policy');
  headers.set('content-security-policy', csp ? withStyleNonce(csp) : staticCsp());
  // R-AUTH-20: nothing the Worker answers is stored; static assets never reach it.
  headers.set('cache-control', 'private, no-store');
  return response;
}

async function guard(
  event: RequestEvent,
  resolve: Parameters<Handle>[0]['resolve'],
  options: PipelineOptions,
  log: LogFields,
): Promise<Response> {
  const { request } = event;
  const path = pathOf(event);

  // R-AUTH-17: a mutating request or socket upgrade from another origin never reaches identity.
  if (MUTATING.has(request.method) || isUpgrade(request)) {
    if (request.headers.get('origin') !== event.url.origin) {
      log.denied = 'cross_origin';
      return apiError('forbidden', {
        requestId: event.locals.requestId,
        locale: event.locals.locale,
      });
    }
  }

  if (PUBLIC_PATHS.has(path) && PUBLIC_METHODS.has(request.method)) {
    const response = await resolve(event);
    // R-AUTH-11: the denial page is a 403 for everyone who lands on it.
    if (path === DENIED_PATH && !event.isDataRequest && response.ok) {
      return new Response(response.body, { status: 403, headers: response.headers });
    }
    return response;
  }

  const context = await options.getContext(event);
  const salt = resolveLogSalt(context.logHashSalt, options.production);
  event.locals.context = context;

  // R-AUTH-12: without the Access vars nobody, not even the bootstrap admin, gets further.
  if (!context.accessConfigured) {
    log.denied = 'locked';
    return locked(event);
  }
  const unlocked = await readSetupUnlocked(context.database.db);

  let identity: { email: string; subject: string };
  try {
    identity = await context.identity.requireIdentity(request, {
      clientAddress: clientAddress(event),
    });
  } catch (error) {
    // INV-1: any failure to verify, expected or not, is a denial.
    log.denied = error instanceof IdentityError ? 'no_identity' : 'identity_error';
    return unlocked ? deny(event) : locked(event);
  }

  const member = await resolveMember(context.database, identity);
  if (!unlocked) {
    // R-AUTH-12: one answer for everyone, known or not, except the bootstrap admin,
    // who reaches the setup checklist and nothing else.
    const bootstrap = member !== null && (await isBootstrapAdmin(context.database.db, member.id));
    if (!bootstrap) {
      log.denied = 'locked';
      return locked(event);
    }
    if (path !== SETUP_PATH || !PUBLIC_METHODS.has(request.method)) {
      log.denied = 'locked';
      return redirectOr(event, SETUP_PATH, () => locked(event));
    }
  }
  if (!member) {
    log.denied = 'no_membership';
    log.subject = await saltedHash(salt, normalizeEmail(identity.email));
    return deny(event);
  }
  event.locals.member = member;
  log.member = await saltedHash(salt, member.id);

  return (await boundBody(event)) ?? (await resolve(event));
}

/** identity → membership → `locals.member`, with the request id, headers and log line (§6). */
export function createSecurityHandle(options: PipelineOptions): Handle {
  return async ({ event, resolve }) => {
    event.locals.requestId = uuidv7();
    event.locals.member = null;
    const log: LogFields = {
      requestId: event.locals.requestId,
      method: event.request.method,
      // The route pattern, never the raw path or query.
      route: event.route.id ?? 'unmatched',
    };

    let response: Response;
    try {
      response = await guard(event, resolve, options, log);
    } catch (error) {
      // Fail closed: a missing binding or a database error shows nothing private.
      log.error = describeError(error);
      response = apiError('unavailable', {
        requestId: event.locals.requestId,
        locale: event.locals.locale,
      });
    }

    response = finalize(event, response);
    log.status = response.status;
    logLine(log);
    return response;
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return 'non-error thrown';
}

/** R-AUTH-23: unexpected errors are logged redacted; the page sees only the request id. */
export const handleServerError: HandleServerError = ({ error, event, status, message }) => {
  logLine({
    requestId: event.locals.requestId,
    route: event.route.id ?? 'unmatched',
    status,
    // A 4xx message can quote the raw path (`Not found: /…`); only server errors need the text.
    ...(status >= 500 ? { error: describeError(error) } : {}),
  });
  return { message, requestId: event.locals.requestId };
};
