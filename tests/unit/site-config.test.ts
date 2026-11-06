import { describe, expect, it } from 'vitest';
import { accentCss } from '../../src/lib/themes/accent';
import { isThemeId, resolveMode } from '../../src/lib/themes/registry';
import { siteDefaults } from '../../site.config';
import { SiteConfigError, siteConfig, validateSiteConfig } from '../../src/lib/config';

describe('AC-UI-04 site configuration', () => {
  it('R-MEM-20 accepts a 1–90 day deletion grace period and defaults to seven days', () => {
    expect(siteConfig.deletedMediaGraceDays).toBe(7);
    for (const value of [1, 90])
      expect(
        validateSiteConfig({ ...siteDefaults, deletedMediaGraceDays: value }).deletedMediaGraceDays,
      ).toBe(value);
    for (const value of [0, 91, 1.5])
      expect(() => validateSiteConfig({ ...siteDefaults, deletedMediaGraceDays: value })).toThrow(
        SiteConfigError,
      );
  });

  it('accepts the shipped defaults and exposes the default theme', () => {
    expect(siteConfig.theme).toBe('yearbook');
    expect(siteConfig.nav).toEqual(['home', 'memories', 'discussions', 'chat', 'members']);
    expect(() => validateSiteConfig(siteDefaults)).not.toThrow();
  });

  it('R-UI-11 defaults the time zone to Asia/Ho_Chi_Minh and refuses one Intl does not know', () => {
    expect(siteConfig.timeZone).toBe('Asia/Ho_Chi_Minh');
    expect(validateSiteConfig({ ...siteDefaults, timeZone: 'Europe/Paris' }).timeZone).toBe(
      'Europe/Paris',
    );
    for (const timeZone of ['Mars/Olympus', '', 'UTC+7; drop', 7])
      expect(() => validateSiteConfig({ ...siteDefaults, timeZone })).toThrow(SiteConfigError);
  });

  it('refuses an unknown theme id', () => {
    expect(() => validateSiteConfig({ ...siteDefaults, theme: 'neon' })).toThrow(SiteConfigError);
    expect(() => validateSiteConfig({ ...siteDefaults, theme: 'neon' })).toThrow(/theme/i);
  });

  it('accepts a per-mode accent that clears 4.5:1 on its own mode surface', () => {
    const accent = { light: '#1f4f9c', dark: '#8cc4ef' };
    expect(validateSiteConfig({ ...siteDefaults, theme: 'yearbook', accent }).accent).toEqual(
      accent,
    );
    expect(() =>
      validateSiteConfig({ ...siteDefaults, theme: 'yearbook', accent: { dark: '#8cc4ef' } }),
    ).not.toThrow();
    expect(() =>
      validateSiteConfig({ ...siteDefaults, theme: 'night', accent: { dark: '#ff8a6b' } }),
    ).not.toThrow();
  });

  it('refuses a light accent under 4.5:1 on the light surface, with its ratio', () => {
    const attempt = () =>
      validateSiteConfig({
        ...siteDefaults,
        theme: 'yearbook',
        accent: { light: '#8cc4ef', dark: '#8cc4ef' },
      });
    expect(attempt).toThrow(SiteConfigError);
    expect(attempt).toThrow(/#8cc4ef measures \d+(\.\d+)?:1 against the yearbook light surface/);
    expect(attempt).not.toThrow(/yearbook dark surface/);
  });

  it('refuses a key for a mode the theme does not ship', () => {
    expect(() =>
      validateSiteConfig({ ...siteDefaults, theme: 'night', accent: { light: '#1f4f9c' } }),
    ).toThrow(/no light mode/);
  });

  it('refuses a malformed accent as a config error, not a contrast crash', () => {
    expect(() => validateSiteConfig({ ...siteDefaults, accent: { light: '#12345' } })).toThrow(
      SiteConfigError,
    );
  });

  it('refuses a bare string accent and unknown accent keys', () => {
    expect(() => validateSiteConfig({ ...siteDefaults, accent: '#1f4f9c' })).toThrow(
      SiteConfigError,
    );
    expect(() =>
      validateSiteConfig({ ...siteDefaults, accent: { light: '#1f4f9c', css: 'a{}' } }),
    ).toThrow(SiteConfigError);
  });

  it('refuses a CSS string in a colour field', () => {
    expect(() =>
      validateSiteConfig({ ...siteDefaults, accent: { light: 'body { color: red }' } }),
    ).toThrow(/rrggbb/i);
  });

  it('refuses an arbitrary CSS property instead of accepting it', () => {
    expect(() => validateSiteConfig({ ...siteDefaults, customCss: 'body { color: red }' })).toThrow(
      SiteConfigError,
    );
  });
});

it('AC-UI-04 registry refuses inherited property names and night ignores light mode', () => {
  expect(isThemeId('toString')).toBe(false);
  expect(isThemeId('__proto__')).toBe(false);
  expect(isThemeId('yearbook')).toBe(true);
  expect(resolveMode('night', 'light')).toBe('dark');
});

describe('R-UI-02 system mode and accent override', () => {
  it('keeps system for themes with both modes and forces night dark', () => {
    expect(resolveMode('yearbook', 'system')).toBe('system');
    expect(resolveMode('minimal', 'system')).toBe('system');
    expect(resolveMode('night', 'system')).toBe('dark');
  });

  it('renders the accent for the rendered mode, both under system, and nothing without one', () => {
    expect(accentCss(null, 'light')).toBe('');
    const accent = { light: '#1f4f9c', dark: '#ffd166' };
    const light = accentCss(accent, 'light');
    expect(light).toContain('--color-accent: #1f4f9c; --color-accent-contrast: #ffffff;');
    expect(light).not.toContain('#ffd166');
    const dark = accentCss(accent, 'dark');
    expect(dark).toContain('--color-accent: #ffd166; --color-accent-contrast: #000000;');
    expect(dark).not.toContain('@media');
    expect(accentCss({ light: '#1f4f9c' }, 'dark')).toBe('');
    const system = accentCss(accent, 'system');
    expect(system).toContain('#1f4f9c');
    expect(system).toMatch(/@media \(prefers-color-scheme: dark\) \{[^@]*#ffd166/);
  });
});

describe('R-NAV-01 nav entries', () => {
  it('refuses a duplicate nav entry', () => {
    expect(() => validateSiteConfig({ ...siteDefaults, nav: ['home', 'home'] })).toThrow(
      SiteConfigError,
    );
  });
});

describe('R-PROF-02 and R-MEM-08 profile fields and uploads', () => {
  it('refuses profile field names that are not schema columns', () => {
    for (const field of ['schoolYears', 'email', 'social']) {
      expect(() =>
        validateSiteConfig({ ...siteDefaults, profileFields: [field] as never }),
      ).toThrow(SiteConfigError);
    }
  });

  it('refuses image/png and a maxImageBytes above 25 MB', () => {
    expect(() =>
      validateSiteConfig({
        ...siteDefaults,
        uploads: { ...siteDefaults.uploads, imageTypes: ['image/png'] as never },
      }),
    ).toThrow(SiteConfigError);
    expect(() =>
      validateSiteConfig({
        ...siteDefaults,
        uploads: { ...siteDefaults.uploads, maxImageBytes: 25_000_001 },
      }),
    ).toThrow(SiteConfigError);
    expect(() =>
      validateSiteConfig({
        ...siteDefaults,
        uploads: { ...siteDefaults.uploads, maxImageBytes: 25_000_000 },
      }),
    ).not.toThrow();
  });
});
