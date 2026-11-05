import { getContext, setContext } from 'svelte';
import type { Locale, MessageKey } from './index';

export interface I18nContext {
  readonly locale: Locale;
  t(key: MessageKey, params?: Record<string, string | number>): string;
  setLocale(locale: Locale): void;
  toggleLocale(): void;
}

const KEY = Symbol('i18n');

export function provideI18n(context: I18nContext): void {
  setContext(KEY, context);
}

export function useI18n(): I18nContext {
  const context = getContext<I18nContext>(KEY);
  if (!context) throw new Error('useI18n must be used inside the app layout');
  return context;
}
