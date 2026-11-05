// R-PROF-06: contact values are normalized on save and rendered only as `tel:`,
// `mailto:` or an allow-listed `https:` link. Pure, so the server validates and the
// browser builds the same hrefs.

const PHONE_CHARS = /^\+?[0-9 ().-]+$/;

/** E.164 (`+84912345678`) where it parses, else as typed; null when it is no phone at all. */
export function normalizePhone(input: string): string | null {
  const text = input.trim().replace(/\s+/g, ' ');
  if (text.length > 32 || !PHONE_CHARS.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  return text.startsWith('+') && digits.length >= 8 ? `+${digits}` : text;
}

export function phoneHref(phone: string): string {
  return `tel:${phone.trim().startsWith('+') ? '+' : ''}${phone.replace(/\D/g, '')}`;
}

export function emailHref(email: string): string {
  return `mailto:${email}`;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * An `https:` URL on an allow-listed host (or its subdomain), with no credentials or
 * port; a bare `zalo.me/…` gets the `https://` it implies. Null for anything else,
 * including `javascript:` and `data:`.
 */
export function normalizeMessagingUrl(input: string, hosts: readonly string[]): string | null {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const allowed = hosts.some((entry) => {
    const listed = entry.toLowerCase();
    return host === listed || host.endsWith(`.${listed}`);
  });
  return allowed && url.href.length <= 300 ? url.href : null;
}
