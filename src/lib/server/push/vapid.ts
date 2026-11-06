// R-NTF-01: RFC 8292 VAPID ES256 JWT on WebCrypto (`sub` = site `https://` origin, no email).

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(input: string): Uint8Array | null {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + '='.repeat(padLen));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface VapidSignOptions {
  endpoint: string;
  sub: string;
  keys: VapidKeys;
  nowMs?: number;
  ttlSeconds?: number;
}

const MAX_VAPID_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_VAPID_TTL_SECONDS = 12 * 60 * 60;

/** Validates that `sub` is an `https://` origin (no email, path, query or credentials). */
export function normalizeOriginSub(sub: string): string {
  let url: URL;
  try {
    url = new URL(sub);
  } catch {
    throw new Error('VAPID sub must be a valid https:// origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('VAPID sub must be a bare https:// origin');
  }
  return url.origin;
}

/** R-NTF-01: signs an ES256 VAPID JWT (`aud` = endpoint origin, `exp` <= 24 h, `sub` = site origin). */
export async function createVapidJwt(options: VapidSignOptions): Promise<string> {
  const aud = new URL(options.endpoint).origin;
  const sub = normalizeOriginSub(options.sub);
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const ttl = Math.min(
    Math.max(1, options.ttlSeconds ?? DEFAULT_VAPID_TTL_SECONDS),
    MAX_VAPID_TTL_SECONDS,
  );
  const exp = nowSec + ttl;

  const pkcs8 = fromBase64Url(options.keys.privateKey);
  if (!pkcs8) throw new Error('Invalid VAPID private key encoding');

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const headerPart = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payloadPart = toBase64Url(encoder.encode(JSON.stringify({ aud, exp, sub })));
  const signingInput = `${headerPart}.${payloadPart}`;
  const sigBuffer = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    encoder.encode(signingInput),
  );
  const sigPart = toBase64Url(new Uint8Array(sigBuffer));
  return `${signingInput}.${sigPart}`;
}

/** R-NTF-01: RFC 8292 §2.2 `Authorization: vapid t=<jwt>, k=<publicKey>` header value. */
export async function createVapidAuthorization(options: VapidSignOptions): Promise<string> {
  const jwt = await createVapidJwt(options);
  return `vapid t=${jwt}, k=${options.keys.publicKey}`;
}

/** Verifies an RFC 8292 `vapid t=..., k=...` header against the public key and returns claims. */
export async function verifyVapidAuthorization(
  authorization: string,
  expectedPublicKey?: string,
  nowMs = Date.now(),
): Promise<{ valid: boolean; claims?: { aud: string; exp: number; sub: string } }> {
  const match =
    /^vapid\s+t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+),\s*k=([A-Za-z0-9_-]+)$/.exec(
      authorization.trim(),
    );
  if (!match) return { valid: false };
  const [, token, pubB64] = match;
  if (!token || !pubB64) return { valid: false };
  if (expectedPublicKey && pubB64 !== expectedPublicKey) return { valid: false };

  const pubBytes = fromBase64Url(pubB64);
  if (!pubBytes || pubBytes.length !== 65 || pubBytes[0] !== 0x04) return { valid: false };

  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const headerBytes = fromBase64Url(headerB64);
  const payloadBytes = fromBase64Url(payloadB64);
  const sigBytes = fromBase64Url(sigB64);
  if (!headerBytes || !payloadBytes || !sigBytes || sigBytes.length !== 64) {
    return { valid: false };
  }

  let header: { typ?: unknown; alg?: unknown };
  let claims: { aud?: unknown; exp?: unknown; sub?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { valid: false };
  }
  if (header.alg !== 'ES256' || header.typ !== 'JWT') return { valid: false };
  if (
    typeof claims.aud !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.sub !== 'string'
  ) {
    return { valid: false };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (claims.exp <= nowSec || claims.exp > nowSec + MAX_VAPID_TTL_SECONDS) {
    return { valid: false };
  }

  try {
    normalizeOriginSub(claims.sub);
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      pubBytes as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sigBytes as BufferSource,
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
    if (!ok) return { valid: false };
    return { valid: true, claims: { aud: claims.aud, exp: claims.exp, sub: claims.sub } };
  } catch {
    return { valid: false };
  }
}
