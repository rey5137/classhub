import { siteConfig } from '../../config';
import { fromBase64Url } from './vapid';

// R-NTF-02: subscription endpoint allow-list and P-256 key validation.

const MAX_ENDPOINT_LENGTH = 2048;

// NIST P-256 (secp256r1) curve parameters for uncompressed point verification.
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

function modP(n: bigint): bigint {
  const r = n % P256_P;
  return r < 0n ? r + P256_P : r;
}

/** Verifies that `bytes` is a 65-byte uncompressed point on the P-256 curve. */
export function isValidP256PublicKeyBytes(bytes: Uint8Array | null): bytes is Uint8Array {
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return false;
  const x = bytesToBigInt(bytes.subarray(1, 33));
  const y = bytesToBigInt(bytes.subarray(33, 65));
  if (x <= 0n || x >= P256_P || y <= 0n || y >= P256_P) return false;
  const lhs = modP(y * y);
  const rhs = modP(modP(x * x * x) - modP(3n * x) + P256_B);
  return lhs === rhs;
}

export function isValidP256DhKey(p256dh: string): boolean {
  if (typeof p256dh !== 'string') return false;
  return isValidP256PublicKeyBytes(fromBase64Url(p256dh));
}

export function isValidPushAuthKey(auth: string): boolean {
  if (typeof auth !== 'string') return false;
  const bytes = fromBase64Url(auth);
  return bytes !== null && bytes.length === 16;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[') || hostname.includes(':')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  // Also reject numeric TLD / hex/octal IPv4 forms (e.g. 127.1 or 0x7f000001).
  const labels = hostname.split('.');
  const last = labels[labels.length - 1] ?? '';
  return /^\d+$/.test(last) || /^0x[0-9a-f]+$/i.test(last);
}

/**
 * R-NTF-02: `https:` only, no port (including explicit `:443`), no credentials,
 * no fragment, no IP literal, and host equal to or under one of `allowedHosts`.
 */
export function isAllowedPushEndpoint(
  endpoint: string,
  allowedHosts: readonly string[] = siteConfig.push.endpointHosts,
): boolean {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    return false;
  }
  // URL parser normalizes `:443` on https: to `port === ""`, so reject explicit port syntax first.
  if (/^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/i.test(endpoint)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.port !== '') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.hash !== '') return false;
  if (!url.pathname || url.pathname === '/') return false;

  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.endsWith('.') || isIpLiteral(hostname)) return false;

  return allowedHosts.some((allowed) => {
    const target = allowed.toLowerCase();
    return hostname === target || hostname.endsWith(`.${target}`);
  });
}

export interface PushSubscriptionKeysInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** R-NTF-02: validates endpoint, 65-byte P-256 `p256dh` point, and 16-byte `auth` secret. */
export function validatePushSubscriptionInput(
  input: PushSubscriptionKeysInput,
  allowedHosts: readonly string[] = siteConfig.push.endpointHosts,
): boolean {
  return (
    isAllowedPushEndpoint(input.endpoint, allowedHosts) &&
    isValidP256DhKey(input.p256dh) &&
    isValidPushAuthKey(input.auth)
  );
}
