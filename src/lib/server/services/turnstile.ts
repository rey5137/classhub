import { TURNSTILE_ORIGIN } from '../headers';

// R-AUTH-27: the one third-party check (R-AUTH-24), verified on the server. The Worker
// reads `TURNSTILE_SITE_KEY` (a var, public) and `TURNSTILE_SECRET_KEY` (a secret).

export interface TurnstileVerifier {
  /** Rendered into the `/join` widget; public by design. */
  siteKey: string;
  /** True only for a token Cloudflare accepted; any failure, timeout or odd reply is false. */
  verify(token: string, remoteIp: string): Promise<boolean>;
}

export const SITEVERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
/** The widget script `/join` loads (implicit rendering), from the one origin its CSP adds. */
export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;
const VERIFY_TIMEOUT_MS = 5_000;

/** Cloudflare's documented test keys: the dummy token passes only the always-pass secret. */
export const TURNSTILE_TEST_KEYS = {
  siteKey: '1x00000000000000000000AA',
  passSecret: '1x0000000000000000000000000000000AA',
  failSecret: '2x0000000000000000000000000000000AA',
  dummyToken: 'XXXX.DUMMY.TOKEN.XXXX',
} as const;

/** Production: one siteverify call, bounded by a timeout. */
export function siteverifyTurnstile(options: {
  siteKey: string;
  secret: string;
  fetch?: typeof fetch;
}): TurnstileVerifier {
  const send = options.fetch ?? fetch;
  return {
    siteKey: options.siteKey,
    async verify(token, remoteIp) {
      const body = new FormData();
      body.set('secret', options.secret);
      body.set('response', token);
      if (remoteIp) body.set('remoteip', remoteIp);
      try {
        const response = await send(SITEVERIFY_URL, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
        if (!response.ok) return false;
        const result = (await response.json()) as { success?: unknown };
        return result.success === true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * `dev:offline` (R-PLAT-10): the test keys answered without the network, as Cloudflare
 * answers them; any other secret goes to siteverify.
 */
export function offlineTurnstile(options: {
  siteKey?: string;
  secret?: string;
}): TurnstileVerifier {
  const siteKey = options.siteKey || TURNSTILE_TEST_KEYS.siteKey;
  const secret = options.secret || TURNSTILE_TEST_KEYS.passSecret;
  if (secret !== TURNSTILE_TEST_KEYS.passSecret && secret !== TURNSTILE_TEST_KEYS.failSecret) {
    return siteverifyTurnstile({ siteKey, secret });
  }
  return {
    siteKey,
    async verify(token) {
      return secret === TURNSTILE_TEST_KEYS.passSecret && token === TURNSTILE_TEST_KEYS.dummyToken;
    },
  };
}
