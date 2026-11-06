import type { Handle, HandleServerError, RequestEvent } from '@sveltejs/kit';
import { normalizeEmail, resolveMember } from './auth/membership';
import { touchLastSeen } from './repositories/users';
import { isBootstrapAdmin } from './repositories/settings';
import type { AppContext } from './context';
import { apiError } from './errors';
import { disabledFeature, routeKey } from './features';
import { securityHeaders, staticCsp, withStyleNonce, withTurnstile } from './headers';
import { uuidv7 } from './ids';
import { IdentityError, type VerifiedIdentity } from './ports/identity';
import { logLine, redact, resolveLogSalt, saltedHash, type LogFields } from './log';
import { JobRunner } from './services/job-runner';
import { meterStorage, recordOperations } from './services/operations';
import { loadSiteState, type SiteState } from './services/settings';

/** R-AUTH-22: JSON and form bodies; uploads (R-MEM-08) and chat frames have their own bounds. */
export const JSON_BODY_LIMIT = 64 * 1024;
export const DENIED_PATH = '/denied';
export const LOCKED_PATH = '/locked';
export const SETUP_PATH = '/admin/setup';
export const JOIN_PATH = '/join';

// R-API-01: everything else, and any other method on these, needs a verified identity and an active membership.
const PUBLIC_PATHS = new Set(['/health', DENIED_PATH, LOCKED_PATH]);
const PUBLIC_METHODS = new Set(['GET', 'HEAD']);
// R-AUTH-27: the form page and its post; any other method on /join needs Access.
const JOIN_METHODS = new Set(['GET', 'HEAD', 'POST']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// R-MEM-08: the streamed upload (PUT only) is bounded by the media limits in its own route.
const UPLOAD_ROUTE = /^\/api\/v1\/media\/reservations\/[^/]+\/[^/]+$/;

export interface PipelineOptions {
  getContext(event: RequestEvent): Promise<AppContext>;
  /** A production build warns once when `LOG_HASH_SALT` is unset. */
  production: boolean;
  /** The clock for `last_seen_at`; tests inject it. */
  now?: () => number;
  /** Observe background work without delaying the response (also on Node). */
  onHousekeeping?: (work: Promise<void>) => void;
  /** Called once the request's settings are read, before anything is answered (R-UI-08). */
  onSettings?: (event: RequestEvent) => void;
}

function pathOf(event: RequestEvent): string {
  return event.url.pathname.replace(/\/+$/, '') || '/';
}

/** What `apiError` needs from the request: its id and the visitor's locale. */
function errorContext(event: RequestEvent) {
  return { requestId: event.locals.requestId, locale: event.locals.locale };
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
  return redirectOr(event, DENIED_PATH, () => apiError('forbidden', errorContext(event)));
}

/** R-AUTH-12: while locked every page shows /locked and every API answers `423 locked`. */
function locked(event: RequestEvent): Response {
  return redirectOr(event, LOCKED_PATH, () => apiError('locked', errorContext(event)));
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
  const options = errorContext(event);

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
  const policy = csp ? withStyleNonce(csp) : staticCsp();
  headers.set('content-security-policy', event.locals.joinOpen ? withTurnstile(policy) : policy);
  // R-MEM-17: only a successful private image response may use its media cache policy.
  const mediaResponse =
    /^\/api\/v1\/media\/[^/]+\/(image|thumb)$/.test(pathOf(event)) &&
    event.request.method === 'GET' &&
    (response.status === 200 || response.status === 304) &&
    ['image/jpeg', 'image/webp'].includes(headers.get('content-type') ?? '');
  if (!mediaResponse) headers.set('cache-control', 'private, no-store');
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
      return apiError('forbidden', errorContext(event));
    }
  }

  if (PUBLIC_PATHS.has(path) && PUBLIC_METHODS.has(request.method)) {
    // /locked and /denied wear the admin's theme and language; a failed read keeps the defaults.
    if (path !== '/health') {
      await options
        .getContext(event)
        .then((context) => loadSiteState(context.database.db))
        .then((state) => applySiteState(event, state, options))
        .catch(() => {});
    }
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
  const { setupUnlocked: unlocked } = applySiteState(
    event,
    await loadSiteState(context.database.db),
    options,
  );

  // R-AUTH-12: without the Access vars nobody, not even the bootstrap admin, gets further.
  if (!context.accessConfigured) {
    log.denied = 'locked';
    return locked(event);
  }
  // R-AUTH-27: past the lock checks (a locked site answers /join as it does every path),
  // and before any identity is read.
  if (unlocked && path === JOIN_PATH && JOIN_METHODS.has(request.method)) {
    // R-AUTH-29: the IP hash must match across isolates, so production needs `LOG_HASH_SALT`.
    return joinGate(event, resolve, log, options.production ? context.logHashSalt : salt);
  }

  let identity: VerifiedIdentity;
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
  event.locals.authUntil = identity.expiresAt;
  log.member = await saltedHash(salt, member.id);
  // R-AUTH-26: best effort; a failed write never denies or slows the request's answer. Behind the
  // Workers runtime it runs under `waitUntil`; without it the caught promise runs in the background.
  const touch = touchLastSeen(context.database.db, member.id, (options.now ?? Date.now)()).catch(
    (error: unknown) => {
      // A fixed value: a driver message can carry the raw member id (R-AUTH-23).
      log.lastSeenError = error instanceof Error ? error.name : 'error';
    },
  );
  const waitUntil = waitUntilOf(event);
  const housekeeping = new JobRunner(context).trigger((options.now ?? Date.now)()).catch(() => {
    logLine({ requestId: log.requestId, housekeepingError: 'failed' });
  });
  if (waitUntil) waitUntil(housekeeping);
  options.onHousekeeping?.(housekeeping);
  if (waitUntil) {
    // The request's own line is usually written before this settles, so a failure gets a line of its own.
    waitUntil(
      touch.then(() => {
        if (log.lastSeenError)
          logLine({ requestId: log.requestId, lastSeenError: log.lastSeenError });
      }),
    );
  } else await touch;

  // R-NAV-02: after membership, admins included. A page GET renders its 404 from
  // each page load (`requireFeature`; a layout load can be skipped); an API or a form post is refused here.
  const route = routeKey(event.route.id, path);
  const api = route.startsWith('/api/');
  if (
    disabledFeature(route, event.locals.settings.features) &&
    (api || !PUBLIC_METHODS.has(request.method))
  ) {
    log.denied = 'feature_disabled';
    return apiError(api ? 'feature_disabled' : 'not_found', errorContext(event));
  }

  // R-MEM-18: every storage call a route makes is counted, then written after it answers.
  const operations = { classA: 0, classB: 0 };
  event.locals.context = { ...context, storage: meterStorage(context.storage, operations) };
  try {
    return (await boundBody(event)) ?? (await resolve(event));
  } finally {
    const write = recordOperations(
      context.database,
      operations,
      (options.now ?? Date.now)(),
    )?.catch(() => {
      logLine({ requestId: log.requestId, operationsError: 'failed' });
    });
    if (write && waitUntil) waitUntil(write);
    else if (write) await write;
  }
}

/**
 * R-AUTH-27: `/join` sits outside Access, and only while the `join` setting is on;
 * off, both methods answer 404. No identity is read, even when a JWT is sent, so the
 * page renders as nobody: the site name and the form, no member data or site media.
 */
async function joinGate(
  event: RequestEvent,
  resolve: Parameters<Handle>[0]['resolve'],
  log: LogFields,
  rateSalt: string | undefined,
): Promise<Response> {
  if (!event.locals.settings.features.join) {
    log.denied = 'feature_disabled';
    return apiError('not_found', errorContext(event));
  }
  event.locals.joinOpen = true;
  event.locals.joinSalt = rateSalt;
  return (await boundBody(event)) ?? (await resolve(event));
}

/** R-UI-01: the request's settings on `locals`, then the appearance hook re-resolves from them. */
function applySiteState(
  event: RequestEvent,
  state: SiteState,
  options: PipelineOptions,
): SiteState {
  event.locals.settings = state.settings;
  event.locals.setupUnlocked = state.setupUnlocked;
  options.onSettings?.(event);
  return state;
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
      response = apiError('unavailable', errorContext(event));
    }

    response = finalize(event, response);
    log.status = response.status;
    logLine(log);
    return response;
  };
}

/** The platform's `ctx.waitUntil`, bound, when the runtime offers one. */
function waitUntilOf(event: RequestEvent): ((work: Promise<unknown>) => void) | null {
  const ctx = event.platform?.ctx as { waitUntil?: unknown } | undefined;
  if (typeof ctx?.waitUntil !== 'function') return null;
  return (work) => (ctx.waitUntil as (work: Promise<unknown>) => void).call(ctx, work);
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
