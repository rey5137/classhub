import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { siteDefaults } from '../site.config';
import { siteConfig, validateSiteConfig } from '$lib/config';
import { isThemeId, resolveMode } from '$lib/themes/registry';
import { accentCss } from '$lib/themes/accent';
import type { RenderedMode, ThemeId } from '$lib/themes/theme-tokens';
import { LOCALE_STORAGE_KEY, parseLocaleCookie } from '$lib/i18n';
import { createContext } from '$lib/server/context';
import { createSecurityHandle, handleServerError } from '$lib/server/pipeline';

const PLACEHOLDER = {
  theme: '%classhub.theme%',
  mode: '%classhub.mode%',
  lang: '%classhub.lang%',
  accent: '%classhub.accent%',
} as const;

// R-UI-08: resolve the active theme and mode before the first paint, then write
// them into <html>. The query override exists only on the dev server so
// `npm run screenshots` and e2e can render every theme × mode.
const appearance: Handle = async ({ event, resolve }) => {
  const preview = import.meta.env.DEV;
  const requestedTheme = preview ? event.url.searchParams.get('theme') : null;
  const theme: ThemeId =
    requestedTheme && isThemeId(requestedTheme) ? requestedTheme : siteConfig.theme;

  const requestedMode = preview ? event.url.searchParams.get('mode') : null;
  const preferred =
    requestedMode === 'light' || requestedMode === 'dark' || requestedMode === 'system'
      ? requestedMode
      : siteConfig.mode;

  // R-UI-02: 'system' is left to prefers-color-scheme in CSS, so there is no flash.
  const mode: RenderedMode = resolveMode(theme, preferred);
  // The dev override goes through the same schema, so a low-contrast or non-colour value is ignored.
  let accent = siteConfig.accent;
  const light = preview ? event.url.searchParams.get('accentLight') : null;
  const dark = preview ? event.url.searchParams.get('accentDark') : null;
  if (light || dark) {
    try {
      accent = validateSiteConfig({
        ...siteDefaults,
        theme,
        accent: { ...(light ? { light } : {}), ...(dark ? { dark } : {}) },
      }).accent;
    } catch {
      /* keep the configured accent */
    }
  }
  const locale = parseLocaleCookie(event.cookies.get(LOCALE_STORAGE_KEY), siteConfig.locale);

  event.locals.theme = theme;
  event.locals.mode = mode;
  event.locals.locale = locale;

  return resolve(event, {
    transformPageChunk: ({ html }) =>
      html
        .replaceAll(PLACEHOLDER.theme, theme)
        .replaceAll(PLACEHOLDER.mode, mode)
        .replaceAll(PLACEHOLDER.lang, locale)
        .replaceAll(PLACEHOLDER.accent, accentCss(accent, mode)),
  });
};

// Appearance first so a denial is localized; it reads only the theme query and
// the locale cookie, nothing private.
export const handle = sequence(
  appearance,
  createSecurityHandle({
    getContext: (event) => createContext(event.platform),
    production: !import.meta.env.DEV,
  }),
);

export const handleError = handleServerError;
