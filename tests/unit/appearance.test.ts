import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { applyAppearance } from '../../src/lib/server/appearance';
import { defaultSettings } from '../../src/lib/server/services/settings';

/** Just what applyAppearance reads: the settings, the URL and the request's cookies. */
function event(cookies: Record<string, string>) {
  return {
    locals: { settings: defaultSettings },
    url: new URL('http://localhost/'),
    cookies: { get: (name: string) => cookies[name] },
  } as unknown as RequestEvent;
}

describe('R-UI-11 the viewer time zone on locals', () => {
  it('takes a valid tz cookie and falls back to the Level B default for none or an unknown one', () => {
    const withCookie = event({ tz: 'Europe/Paris' });
    applyAppearance(withCookie);
    expect(withCookie.locals.timeZone).toBe('Europe/Paris');
    for (const cookies of [{}, { tz: 'Mars/Olympus' }, { tz: '' }] as Record<string, string>[]) {
      const fallback = event(cookies);
      applyAppearance(fallback);
      expect(fallback.locals.timeZone).toBe('Asia/Ho_Chi_Minh');
    }
  });
});
