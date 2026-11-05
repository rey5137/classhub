import { describe, expect, it } from 'vitest';
import config from '../../svelte.config.js';
import { cspDirectives, staticCsp, withStyleNonce } from '../../src/lib/server/headers';

function directive(csp: string, name: string): string[] {
  const found = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([first]) => first === name);
  return found?.slice(1) ?? [];
}

describe('CSP', () => {
  it("R-AUTH-20 script-src and style-src never allow 'unsafe-inline'", () => {
    for (const csp of [
      staticCsp(),
      withStyleNonce(`${staticCsp()}; script-src 'self' 'nonce-abc'`),
    ]) {
      expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
      expect(directive(csp, 'style-src')).not.toContain("'unsafe-inline'");
    }
    expect(cspDirectives['script-src']).not.toContain('unsafe-inline');
    expect(cspDirectives['style-src']).not.toContain('unsafe-inline');
    expect(directive(staticCsp(), 'style-src-attr')).toEqual(["'unsafe-inline'"]);
  });

  it('R-AUTH-20 SvelteKit renders pages in nonce mode with the same directives', () => {
    expect(config.kit?.csp?.mode).toBe('nonce');
    expect(config.kit?.csp?.directives).toEqual(cspDirectives);
  });

  it('R-AUTH-20 the static policy has every §6.7 directive', () => {
    expect(staticCsp()).toBe(
      "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; script-src 'self'; " +
        "style-src 'self'; style-src-attr 'unsafe-inline'; frame-ancestors 'none'; " +
        "form-action 'self'; base-uri 'none'",
    );
  });

  it("adds the page's script nonce to style-src", () => {
    const sveltekit =
      "default-src 'self'; script-src 'self' 'nonce-Ab+1/='; style-src 'self'; style-src-attr 'unsafe-inline'";
    expect(withStyleNonce(sveltekit)).toBe(
      "default-src 'self'; script-src 'self' 'nonce-Ab+1/='; style-src 'self' 'nonce-Ab+1/='; style-src-attr 'unsafe-inline'",
    );
    expect(withStyleNonce(withStyleNonce(sveltekit))).toBe(withStyleNonce(sveltekit));
  });

  it("leaves dev's style-src 'unsafe-inline' alone, since a nonce would disable it", () => {
    const dev = "script-src 'self' 'nonce-x'; style-src 'self' 'unsafe-inline'";
    expect(withStyleNonce(dev)).toBe(dev);
    expect(withStyleNonce("style-src 'self'")).toBe("style-src 'self'");
  });
});
