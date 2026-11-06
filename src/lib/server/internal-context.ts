import { z } from 'zod';
import { toBase64Url } from './push/vapid';

// R-CHAT-04: the member context the Worker hands the ChatRoom on a fresh internal
// request. The room trusts nothing else about who is on the socket, so the token is
// an HMAC-SHA-256 over the JSON under `INTERNAL_CONTEXT_KEY`, valid for 30 s.

export const CONTEXT_HEADER = 'x-classhub-context';
export const CONTEXT_TTL_MS = 30_000;

export const memberContextSchema = z
  .object({
    memberId: z.string().min(1),
    role: z.enum(['member', 'admin']),
    displayName: z.string(),
    /** The verified Access JWT's `exp`, in ms (R-CHAT-16). */
    authUntil: z.number().int().nonnegative(),
    /** This token's own expiry, in ms. */
    exp: z.number().int().nonnegative(),
  })
  .strict();
export type MemberContext = z.infer<typeof memberContextSchema>;

const encoder = new TextEncoder();

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** `<base64url JSON>.<base64url HMAC>`; `exp` is set here, never by the caller. */
export async function signContext(
  context: Omit<MemberContext, 'exp'>,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  if (!secret) throw new Error('INTERNAL_CONTEXT_KEY is not set');
  const payload: MemberContext = { ...context, exp: now + CONTEXT_TTL_MS };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * The context when the token is well formed, signed under `secret` and unexpired;
 * otherwise null. A missing secret verifies nothing (fail closed).
 */
export async function verifyContext(
  token: string | null | undefined,
  secret: string | undefined,
  now: number = Date.now(),
): Promise<MemberContext | null> {
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signed] = parts as [string, string];
  const signature = fromBase64Url(signed);
  if (!signature || !body) return null;
  // WebCrypto's HMAC verify compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    encoder.encode(body),
  );
  if (!valid) return null;

  const bytes = fromBase64Url(body);
  if (!bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const parsed = memberContextSchema.safeParse(json);
  if (!parsed.success || parsed.data.exp <= now) return null;
  return parsed.data;
}
