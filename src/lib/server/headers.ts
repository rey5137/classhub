// R-AUTH-20: the security headers. svelte.config.js imports the CSP directives
// too (SvelteKit's nonce mode), so this file has no imports and only erasable
// TypeScript: Node loads it directly.

/** SvelteKit `kit.csp.directives` form: keywords without quotes. */
export const cspDirectives = {
  'default-src': ['self'],
  'img-src': ['self', 'blob:', 'data:'],
  // CSP3 'self' also matches the same-origin ws:/wss: URL of the chat socket.
  'connect-src': ['self'],
  'script-src': ['self'],
  // The inline <style> in app.html carries the page nonce; style attributes
  // (Avatar, Tile) are the only inline styles allowed without one.
  'style-src': ['self'],
  'style-src-attr': ['unsafe-inline'],
  'frame-ancestors': ['none'],
  'form-action': ['self'],
  'base-uri': ['none'],
} as const satisfies Record<string, readonly string[]>;

const KEYWORDS = new Set(['self', 'none', 'unsafe-inline', 'strict-dynamic']);

/** The policy for responses SvelteKit did not render (JSON, redirects): no nonce needed. */
export function staticCsp(): string {
  return Object.entries(cspDirectives)
    .map(([name, values]) =>
      [name, ...values.map((value) => (KEYWORDS.has(value) ? `'${value}'` : value))].join(' '),
    )
    .join('; ');
}

/**
 * SvelteKit adds the nonce to `script-src` only; the app.html <style> uses the
 * same nonce, so it is added to `style-src` too. In dev SvelteKit puts
 * 'unsafe-inline' there for Vite's injected styles, and a nonce would disable it.
 */
export function withStyleNonce(csp: string): string {
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  if (!nonce) return csp;
  return csp
    .split(';')
    .map((directive) => {
      const trimmed = directive.trim();
      if (!/^style-src\s/.test(trimmed)) return trimmed;
      if (trimmed.includes("'unsafe-inline'") || trimmed.includes(`'nonce-${nonce}'`)) {
        return trimmed;
      }
      return `${trimmed} 'nonce-${nonce}'`;
    })
    .join('; ');
}

export const securityHeaders = {
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-robots-tag': 'noindex, nofollow',
} as const;
