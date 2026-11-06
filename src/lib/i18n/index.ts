import { en } from './en';
import { vi } from './vi';

export type Locale = 'vi' | 'en';
export type MessageKey = keyof typeof vi;

export const LOCALE_STORAGE_KEY = 'classhub.locale';

export const dictionaries: Record<Locale, Record<MessageKey, string>> = { vi, en };

type Params = Record<string, string | number>;

export function t(locale: Locale, key: MessageKey, params?: Params): string {
  const template = dictionaries[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** A count string's base: the key without its `.one` / `.other` ending. */
export type PluralBase = {
  [K in MessageKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends MessageKey
      ? Base
      : never
    : never;
}[MessageKey];

/** R-UI-10: the `.one` or `.other` key the locale's plural rules pick for `count` ("1 reply"). */
export function pluralKey(locale: Locale, base: PluralBase, count: number): MessageKey {
  const category = new Intl.PluralRules(locale).select(count);
  return `${base}.${category === 'one' ? 'one' : 'other'}`;
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'vi' || value === 'en';
}

export function parseLocaleCookie(value: string | undefined, fallback: Locale): Locale {
  return isLocale(value) ? value : fallback;
}

export function localeCookie(locale: Locale, secure: boolean): string {
  return `${LOCALE_STORAGE_KEY}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Cookie persistence still works when browser storage is unavailable.
  }
  document.cookie = localeCookie(locale, location.protocol === 'https:');
}
