import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';

// A local stand-in for the Access team's JWKS: keys are generated per test run,
// so no private key is ever committed (INV-6).

export const TEAM_DOMAIN = 'classhub-test.cloudflareaccess.com';
export const ISSUER = `https://${TEAM_DOMAIN}`;
export const AUDIENCE = 'test-aud-0123456789abcdef';
export const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function createTestKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, publicJwk };
}

export function jwks(...keys: TestKey[]): { keys: JWK[] } {
  return { keys: keys.map((key) => key.publicJwk) };
}

export interface SignOptions {
  email?: string | null;
  sub?: string;
  aud?: string;
  iss?: string;
  /** Seconds relative to now. */
  expiresIn?: number;
  notBefore?: number;
  kid?: string;
  extra?: JWTPayload;
}

export async function signAccessJwt(key: TestKey, options: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = { ...options.extra };
  if (options.email !== null) claims.email = options.email ?? 'member@example.test';
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? key.kid })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? AUDIENCE)
    .setSubject(options.sub ?? 'sub-member')
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresIn ?? 300));
  if (options.notBefore !== undefined) jwt.setNotBefore(now + options.notBefore);
  return jwt.sign(key.privateKey);
}

function base64url(value: string): string {
  return btoa(value).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** `alg: none`, no signature: must never verify. */
export function unsignedJwt(payload: JWTPayload): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}.`;
}

/** A fetch double serving the given JWKS and counting calls. */
export function fakeJwksFetch(initial: { keys: JWK[] } | Error) {
  let current: { keys: JWK[] } | Error = initial;
  const calls: string[] = [];
  const fetcher = async (input: string): Promise<Response> => {
    calls.push(input);
    if (current instanceof Error) throw current;
    return new Response(JSON.stringify(current), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetch: fetcher,
    calls,
    serve(next: { keys: JWK[] } | Error) {
      current = next;
    },
  };
}
