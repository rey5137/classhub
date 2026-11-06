import type { Handle, RequestEvent, ResolveOptions } from '@sveltejs/kit';
import { AccessIdentityProvider } from '../../src/lib/server/adapters/cloudflare/access-identity';
import type { AppContext } from '../../src/lib/server/context';
import { appearance, applyAppearance } from '../../src/lib/server/appearance';
import { createSecurityHandle } from '../../src/lib/server/pipeline';
import type { Database } from '../../src/lib/server/ports/database';
import type { ObjectStorage } from '../../src/lib/server/ports/object-storage';
import type { RealtimeHub } from '../../src/lib/server/ports/realtime';
import type { TurnstileVerifier } from '../../src/lib/server/services/turnstile';
import {
  AUDIENCE,
  createTestKey,
  fakeJwksFetch,
  jwks,
  signAccessJwt,
  TEAM_DOMAIN,
  type TestKey,
} from './access-jwt';

// Drives the real request pipeline (src/lib/server/pipeline.ts) with the Access
// adapter against a local JWKS and signed test JWTs: no bypass in app code.

export const ORIGIN = 'https://classhub.example.test';
export const NONCE_PLACEHOLDER = '__nonce__';

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** The SvelteKit route id the path matched, or null when none did. */
  routeId?: string | null;
  isDataRequest?: boolean;
  params?: Record<string, string>;
  cookies?: Record<string, string>;
  /** The visitor's address (`getClientAddress`); one fixed address otherwise. */
  clientAddress?: string;
}

export interface Harness {
  teamKey: TestKey;
  settleHousekeeping(): Promise<void>;
  /** Paths that reached the route handler (i.e. passed the guard). */
  resolved: string[];
  send(path: string, options?: SendOptions): Promise<Response>;
  /** An assertion header for a team-signed JWT carrying `email`. */
  as(email: string, sub?: string): Promise<Record<string, string>>;
}

/** A RealtimeHub that remembers whom it was asked to disconnect (R-CHAT-09). */
export function recordingHub(): RealtimeHub & { disconnected: string[] } {
  const disconnected: string[] = [];
  return {
    disconnected,
    async connect() {
      return new Response(null, { status: 501 });
    },
    async disconnectMember(memberId) {
      disconnected.push(memberId);
    },
    async notify() {},
  };
}

/** Stands in for SvelteKit's renderer: a page with a nonced CSP, as nonce mode emits. */
function render(event: RequestEvent): Response {
  const nonce = crypto.randomUUID();
  const html = `<!doctype html><html lang="%classhub.lang%" data-theme="%classhub.theme%" data-mode="%classhub.mode%" data-density="%classhub.density%"><head><link rel="icon" href="%classhub.favicon%" /><style nonce="${nonce}">#app{display:contents}%classhub.accent%</style><script nonce="${nonce}">0</script></head><body>${event.url.pathname}</body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html',
      'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; style-src-attr 'unsafe-inline'; frame-ancestors 'none'`,
    },
  });
}

export async function createHarness(
  database: Database,
  options: {
    resolve?: (event: RequestEvent) => Response | Promise<Response>;
    logHashSalt?: string;
    realtime?: RealtimeHub;
    /** R-AUTH-12: false acts as a deployment whose Access vars are missing. */
    accessConfigured?: boolean;
    /** The pipeline clock (R-AUTH-26). */
    now?: () => number;
    storage?: ObjectStorage;
    /** R-UI-08: run hooks.server.ts's appearance handle in front, as the app does. */
    appearance?: boolean;
    /** R-AUTH-27: the `/join` Turnstile check; absent as in a deployment without its keys. */
    turnstile?: TurnstileVerifier;
    /** A production build: `LOG_HASH_SALT` must then be set (R-AUTH-23, R-AUTH-29). */
    production?: boolean;
  } = {},
): Promise<Harness> {
  const teamKey = await createTestKey('team-key');
  const identity = new AccessIdentityProvider({
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    fetch: fakeJwksFetch(jwks(teamKey)).fetch,
  });
  const context: AppContext = {
    database,
    storage: options.storage ?? ({} as ObjectStorage),
    identity,
    accessConfigured: options.accessConfigured ?? true,
    realtime: options.realtime ?? recordingHub(),
    ...(options.logHashSalt ? { logHashSalt: options.logHashSalt } : {}),
    ...(options.turnstile ? { turnstile: options.turnstile } : {}),
  };
  const background: Promise<void>[] = [];
  const security = createSecurityHandle({
    onHousekeeping: (work) => {
      background.push(work);
    },
    getContext: async () => context,
    production: options.production ?? false,
    ...(options.now ? { now: options.now } : {}),
    ...(options.appearance ? { onSettings: applyAppearance } : {}),
  });
  const handle: Handle = options.appearance
    ? ({ event, resolve }) =>
        appearance({
          event,
          resolve: (inner, opts) =>
            security({ event: inner, resolve: (last) => resolve(last, opts) }),
        })
    : security;
  const resolved: string[] = [];

  return {
    teamKey,
    resolved,
    async settleHousekeeping() {
      await Promise.all(background);
    },
    async as(email, sub = `sub:${email}`) {
      return { 'cf-access-jwt-assertion': await signAccessJwt(teamKey, { email, sub }) };
    },
    async send(path, sendOptions = {}) {
      const request = new Request(new URL(path, ORIGIN), {
        method: sendOptions.method ?? 'GET',
        headers: sendOptions.headers,
        body: sendOptions.body ?? null,
        ...(sendOptions.body instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
      const event = {
        request,
        url: new URL(request.url),
        locals: { theme: 'yearbook', mode: 'light', locale: 'en' },
        route: { id: sendOptions.routeId === undefined ? path : sendOptions.routeId },
        params: sendOptions.params ?? {},
        isDataRequest: sendOptions.isDataRequest ?? false,
        isSubRequest: false,
        platform: undefined,
        getClientAddress: () => sendOptions.clientAddress ?? '203.0.113.7',
        setHeaders: () => {},
        cookies: { get: (name: string) => sendOptions.cookies?.[name] },
      } as unknown as RequestEvent;
      return handle({
        event,
        resolve: async (resolvedEvent: RequestEvent, opts?: ResolveOptions) => {
          resolved.push(`${resolvedEvent.request.method} ${resolvedEvent.url.pathname}`);
          const response = await (options.resolve ?? render)(resolvedEvent);
          const transform = opts?.transformPageChunk;
          if (!transform || !response.headers.get('content-type')?.startsWith('text/html')) {
            return response;
          }
          const html = (await transform({ html: await response.text(), done: true })) ?? '';
          return new Response(html, response);
        },
      });
    },
  };
}

/** AC-AUTH-05: status, headers and body, with the request id dropped and the nonce masked. */
export async function comparable(response: Response) {
  const csp = response.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  const mask = (text: string) => (nonce ? text.replaceAll(nonce, NONCE_PLACEHOLDER) : text);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'x-request-id') headers[name] = mask(value);
  });
  const body = await response.text();
  const requestId = response.headers.get('x-request-id');
  return {
    status: response.status,
    headers,
    body: mask(requestId ? body.replaceAll(requestId, '<request-id>') : body),
  };
}
