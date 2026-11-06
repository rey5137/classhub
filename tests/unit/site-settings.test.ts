import { describe, expect, it } from 'vitest';
import { settingsPatchSchema, siteSettingsSchema } from '../../src/lib/contracts/settings';
import { disabledFeature, featureOf } from '../../src/lib/server/features';
import { defaultSettings, effectiveSettings } from '../../src/lib/server/services/settings';

const full = (overrides: Record<string, unknown>) => ({ ...defaultSettings, ...overrides });
const issues = (input: unknown) => {
  const result = siteSettingsSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('AC-UI-04 Level A settings schema (R-UI-01, R-UI-04)', () => {
  it('accepts the defaults and the bounds', () => {
    expect(siteSettingsSchema.parse(defaultSettings)).toEqual(defaultSettings);
    expect(
      siteSettingsSchema.safeParse(
        full({
          name: 'n'.repeat(80),
          years: 'y'.repeat(40),
          description: 'd'.repeat(300),
          welcome: '**Chào** > quoted\n\n- a\n- b'.padEnd(2000, '.'),
        }),
      ).success,
    ).toBe(true);
  });

  it('refuses over-long text, CSS, HTML and unknown keys', () => {
    for (const overrides of [
      { name: 'n'.repeat(81) },
      { years: 'y'.repeat(41) },
      { description: 'd'.repeat(301) },
      { welcome: 'w'.repeat(2001) },
      { name: 'a { color: red }' },
      { description: 'background: url(x)' },
      { welcome: '<img src=x onerror=alert(1)>' },
      { welcome: '<!-- hidden -->' },
      { css: 'body{}' },
      { theme: 'neon' },
      { density: 'tight' },
      { locale: 'fr' },
      { features: { memories: true, discussions: true } },
    ]) {
      expect(siteSettingsSchema.safeParse(full(overrides)).success, JSON.stringify(overrides)).toBe(
        false,
      );
    }
  });

  it('uses the Level B accent rule: each key against its own mode, with the measured ratio', () => {
    expect(
      issues(full({ theme: 'yearbook', accent: { light: '#1f4f9c', dark: '#8cc4ef' } })),
    ).toEqual([]);
    expect(issues(full({ theme: 'yearbook', accent: { light: '#8cc4ef' } }))[0]).toMatch(
      /#8cc4ef measures \d+\.\d\d:1 against the yearbook light surface; 4.5:1 is required/,
    );
    expect(issues(full({ theme: 'night', accent: { light: '#1f4f9c' } }))[0]).toMatch(
      /Theme night has no light mode/,
    );
    expect(issues(full({ accent: { light: '#12345' } })).length).toBeGreaterThan(0);
  });

  it('a patch is partial and strict, and feature flags may be sent one at a time', () => {
    expect(settingsPatchSchema.parse({})).toEqual({});
    expect(settingsPatchSchema.parse({ features: { chat: false } })).toEqual({
      features: { chat: false },
    });
    expect(settingsPatchSchema.safeParse({ features: { forum: true } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ setup_state: 'unlocked' }).success).toBe(false);
  });
});

describe('effective settings (R-UI-01)', () => {
  const rows = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('overlays the stored rows on the Level B defaults', () => {
    const settings = effectiveSettings(
      rows({
        name: JSON.stringify('Lớp 12A'),
        features: JSON.stringify({
          memories: true,
          discussions: false,
          chat: true,
          join: true,
          notifications: false,
        }),
        setup_state: JSON.stringify('unlocked'),
      }),
    );
    expect(settings).toEqual({
      ...defaultSettings,
      name: 'Lớp 12A',
      features: {
        memories: true,
        discussions: false,
        chat: true,
        join: true,
        notifications: false,
      },
    });
  });

  it('R-UI-01 a toggles row stored before `join` existed keeps its flags; join takes its default', () => {
    const settings = effectiveSettings(
      rows({ features: JSON.stringify({ memories: true, discussions: false, chat: false }) }),
    );
    expect(settings.features).toEqual({
      memories: true,
      discussions: false,
      chat: false,
      join: false,
      notifications: true,
    });
    expect(effectiveSettings(rows({ features: JSON.stringify({ chat: 'off' }) })).features).toEqual(
      defaultSettings.features,
    );
  });

  it('ignores a row that is not JSON or no longer parses', () => {
    expect(effectiveSettings(rows({ name: '{', theme: JSON.stringify('neon') }))).toEqual(
      defaultSettings,
    );
  });

  it('drops a stored accent the stored theme refuses instead of rendering it', () => {
    const settings = effectiveSettings(
      rows({ theme: JSON.stringify('night'), accent: JSON.stringify({ light: '#1f4f9c' }) }),
    );
    expect(settings.theme).toBe('night');
    expect(settings.accent).toBeNull();
  });
});

describe('feature routes (R-NAV-02)', () => {
  it('maps each feature’s pages and APIs, and nothing else', () => {
    expect(featureOf('/memories')).toBe('memories');
    expect(featureOf('/memories/abc')).toBe('memories');
    expect(featureOf('/api/v1/albums/abc')).toBe('memories');
    expect(featureOf('/api/v1/media')).toBe('memories');
    expect(featureOf('/discussions/abc')).toBe('discussions');
    expect(featureOf('/api/v1/posts/abc/comments')).toBe('discussions');
    expect(featureOf('/api/v1/comments/abc')).toBe('discussions');
    expect(featureOf('/chat')).toBe('chat');
    expect(featureOf('/api/v1/chat/messages')).toBe('chat');
    expect(featureOf('/notifications')).toBe('notifications');
    expect(featureOf('/api/v1/notifications')).toBe('notifications');
    expect(featureOf('/api/v1/notifications/subscriptions/abc')).toBe('notifications');
    // Shared with avatars and site media: the media service refuses only a photo there.
    expect(featureOf('/api/v1/media/reservations')).toBeNull();
    expect(featureOf('/api/v1/media/reservations/abc/image')).toBeNull();
    expect(featureOf('/api/v1/media/abc/image')).toBeNull();
    expect(featureOf('/api/v1/media/abc')).toBeNull();
    for (const path of [
      '/',
      '/members',
      '/profile',
      '/admin',
      '/info/reunion',
      '/memoriesx',
      '/chatroom',
    ]) {
      expect(featureOf(path), path).toBeNull();
    }
  });

  it('a route is disabled only while its own flag is off', () => {
    const features = {
      memories: true,
      discussions: false,
      chat: true,
      join: false,
      notifications: true,
    };
    expect(disabledFeature('/discussions', features)).toBe('discussions');
    expect(disabledFeature('/memories', features)).toBeNull();
    expect(disabledFeature('/members', features)).toBeNull();
  });
});
