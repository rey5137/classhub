import { describe, expect, it } from 'vitest';
import { en } from '../../src/lib/i18n/en';
import { localeCookie, parseLocaleCookie, pluralKey, t } from '../../src/lib/i18n';
import { vi } from '../../src/lib/i18n/vi';

describe('AC-UI-06 message dictionaries', () => {
  it('every key exists in both locales with non-empty copy', () => {
    const viKeys = Object.keys(vi).sort();
    const enKeys = Object.keys(en).sort();

    expect(enKeys).toEqual(viKeys);
    for (const key of viKeys) {
      expect(vi[key as keyof typeof vi].trim()).not.toBe('');
      expect(en[key as keyof typeof en].trim()).not.toBe('');
    }
  });

  it('interpolates named parameters without leaving a token behind', () => {
    expect(t('vi', 'mem.albumMeta', { month: '03', year: 2006, count: 14 })).toBe(
      '03.2006 · 14 ảnh',
    );
    expect(t('en', 'mem.albumMeta', { month: '03', year: 2006, count: 14 })).toBe(
      '03.2006 · 14 photos',
    );
    expect(t('vi', 'home.membersJoined', { joined: 32, total: 41 })).not.toContain('{');
  });

  it('R-UI-10 picks the singular or plural count string by the locale plural rules', () => {
    const replies = (locale: 'vi' | 'en', count: number) =>
      t(locale, pluralKey(locale, 'brd.replies', count), { count });
    expect(replies('en', 1)).toBe('1 reply');
    expect(replies('en', 0)).toBe('0 replies');
    expect(replies('en', 2)).toBe('2 replies');
    expect(replies('vi', 1)).toBe('1 trả lời');
    expect(replies('vi', 2)).toBe('2 trả lời');
  });
});

describe('R-UI-10 locale cookie', () => {
  it.each(['vi', 'en'] as const)('accepts the known locale %s', (locale) => {
    expect(parseLocaleCookie(locale, locale === 'vi' ? 'en' : 'vi')).toBe(locale);
  });

  it.each([undefined, '', 'fr', 'EN', 'en; Path=/', '<script>'])('defaults for %s', (value) => {
    expect(parseLocaleCookie(value, 'vi')).toBe('vi');
    expect(parseLocaleCookie(value, 'en')).toBe('en');
  });

  it('writes a year-long first-party cookie and adds Secure only for HTTPS', () => {
    expect(localeCookie('en', false)).toBe(
      'classhub.locale=en; Path=/; Max-Age=31536000; SameSite=Lax',
    );
    expect(localeCookie('vi', true)).toBe(
      'classhub.locale=vi; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    );
  });
});

describe('chat lede retention', () => {
  it('R-UI-10 interpolates the configured retention days in both locales', async () => {
    const { t } = await import('../../src/lib/i18n');
    for (const locale of ['vi', 'en'] as const) {
      expect(t(locale, 'chat.lede', { days: 365 })).toContain('365');
      expect(t(locale, 'chat.lede', { days: 365 })).not.toContain('90');
    }
  });
});
