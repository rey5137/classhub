import { describe, expect, it, vi } from 'vitest';
import { staticCsp, withTurnstile } from '../../src/lib/server/headers';
import {
  offlineTurnstile,
  SITEVERIFY_URL,
  siteverifyTurnstile,
  TURNSTILE_TEST_KEYS,
} from '../../src/lib/server/services/turnstile';

// R-AUTH-27: the server-side Turnstile check and the one CSP change it needs.

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('siteverify (R-AUTH-27)', () => {
  it('posts the secret, token and address once, with a timeout, and passes only success: true', async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      reply({ success: true }),
    );
    const verifier = siteverifyTurnstile({
      siteKey: 'site',
      secret: 's3cret',
      fetch: fetch as never,
    });
    expect(await verifier.verify('token-1', '203.0.113.5')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(SITEVERIFY_URL);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = init?.body as FormData;
    expect([body.get('secret'), body.get('response'), body.get('remoteip')]).toEqual([
      's3cret',
      'token-1',
      '203.0.113.5',
    ]);
  });

  it('fails closed on a refusal, an error status, an odd body, a network error or a timeout', async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => reply({ success: false, 'error-codes': ['invalid-input-response'] }),
      async () => reply({ success: 'true' }),
      async () => reply({ success: true }, 500),
      async () => new Response('not json'),
      async () => {
        throw new TypeError('network down');
      },
      async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ];
    for (const answer of answers) {
      const verifier = siteverifyTurnstile({ siteKey: 's', secret: 'x', fetch: answer as never });
      expect(await verifier.verify('token', '')).toBe(false);
    }
  });
});

describe('dev:offline Turnstile (R-PLAT-10)', () => {
  it("answers Cloudflare's test keys without the network", async () => {
    const pass = offlineTurnstile({});
    expect(pass.siteKey).toBe(TURNSTILE_TEST_KEYS.siteKey);
    expect(await pass.verify(TURNSTILE_TEST_KEYS.dummyToken, '')).toBe(true);
    expect(await pass.verify('anything-else', '')).toBe(false);
    const fail = offlineTurnstile({ secret: TURNSTILE_TEST_KEYS.failSecret });
    expect(await fail.verify(TURNSTILE_TEST_KEYS.dummyToken, '')).toBe(false);
  });
});

describe('the /join CSP (R-AUTH-20, R-AUTH-24)', () => {
  it('adds Turnstile to script-src and frame-src only, keeping every other directive', () => {
    const base = "default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'self' 'nonce-abc'";
    expect(withTurnstile(base)).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc' https://challenges.cloudflare.com; style-src 'self' 'nonce-abc'; frame-src https://challenges.cloudflare.com",
    );
    const widened = withTurnstile(staticCsp());
    const directives = (csp: string) => csp.split('; ').map((d) => d.split(' ')[0]);
    expect(directives(widened)).toEqual([...directives(staticCsp()), 'frame-src']);
    expect(staticCsp()).not.toContain('challenges.cloudflare.com');
  });
});
