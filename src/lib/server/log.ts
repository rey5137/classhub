// R-AUTH-23: one structured line per request. Only ids, route patterns, status
// codes and salted hashes are logged: never an email, contact field, message
// body, caption or JWT.

const encoder = new TextEncoder();
let isolateSalt: string | undefined;
let warnedMissingSalt = false;
const keys = new Map<string, Promise<CryptoKey>>();

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `LOG_HASH_SALT` keeps hashes comparable across isolates; without it (dev,
 * tests) each isolate draws its own, so hashes only match within one isolate.
 */
export function resolveLogSalt(configured: string | undefined, production: boolean): string {
  if (configured) return configured;
  if (production && !warnedMissingSalt) {
    warnedMissingSalt = true;
    console.warn(JSON.stringify({ level: 'warn', config: 'LOG_HASH_SALT is not set' }));
  }
  return (isolateSalt ??= randomSalt());
}

/** HMAC-SHA-256 of `value` under the salt, shortened: enough to correlate lines, not to reverse. */
export async function saltedHash(salt: string, value: string): Promise<string> {
  let key = keys.get(salt);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(salt),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    keys.set(salt, key);
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(value)));
  return Array.from(mac.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;

/** For free text that may reach a log (an error message): masks emails, JWTs and phone numbers. */
export function redact(text: string): string {
  return text
    .replace(JWT, '[jwt]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[number]')
    .slice(0, 500);
}

export type LogFields = Record<string, string | number | undefined>;

export function logLine(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}
