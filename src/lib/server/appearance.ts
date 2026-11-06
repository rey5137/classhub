import type { Handle, RequestEvent } from '@sveltejs/kit';
import { siteDefaults } from '../../../site.config';
import { siteConfig, validateSiteConfig } from '../config';
import { LOCALE_STORAGE_KEY, parseLocaleCookie } from '../i18n';
import { parseTimeZone, TIME_ZONE_COOKIE } from '../shared/time';
import { accentCss, type AccentConfig } from '../themes/accent';
import { isThemeId, resolveMode } from '../themes/registry';
import type { RenderedMode, ThemeId } from '../themes/theme-tokens';
import { defaultSettings } from './services/settings';

const PLACEHOLDER = {
  theme: '%classhub.theme%',
  mode: '%classhub.mode%',
  density: '%classhub.density%',
  lang: '%classhub.lang%',
  accent: '%classhub.accent%',
  favicon: '%classhub.favicon%',
} as const;

const STATIC_FAVICON = '/favicon.svg';

/**
 * R-UI-08: the active theme, mode and accent from the request's settings. The query
 * override exists only on the dev server so `npm run screenshots` and e2e can render
 * every theme × mode.
 */
function appearanceOf(event: RequestEvent): {
  theme: ThemeId;
  mode: RenderedMode;
  accent: AccentConfig;
} {
  const { settings } = event.locals;
  const preview = import.meta.env.DEV;
  const requestedTheme = preview ? event.url.searchParams.get('theme') : null;
  const theme: ThemeId =
    requestedTheme && isThemeId(requestedTheme) ? requestedTheme : settings.theme;

  const requestedMode = preview ? event.url.searchParams.get('mode') : null;
  const preferred =
    requestedMode === 'light' || requestedMode === 'dark' || requestedMode === 'system'
      ? requestedMode
      : settings.mode;

  // R-UI-02: 'system' is left to prefers-color-scheme in CSS, so there is no flash.
  const mode: RenderedMode = resolveMode(theme, preferred);
  // A previewed theme drops an accent set for another theme; the dev override goes
  // through the same schema, so a low-contrast or non-colour value is ignored.
  let accent = theme === settings.theme ? settings.accent : null;
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
  return { theme, mode, accent };
}

/** Theme, mode and locale on `locals`; called again once the pipeline has read the settings. */
export function applyAppearance(event: RequestEvent): void {
  const { theme, mode } = appearanceOf(event);
  event.locals.theme = theme;
  event.locals.mode = mode;
  // R-UI-10: the member's own locale cookie wins over the admin's default language.
  event.locals.locale = parseLocaleCookie(
    event.cookies.get(LOCALE_STORAGE_KEY),
    event.locals.settings.locale,
  );
  // R-UI-11: the browser's own zone once the layout has stored it; an unknown one is ignored.
  event.locals.timeZone = parseTimeZone(event.cookies.get(TIME_ZONE_COOKIE), siteConfig.timeZone);
}

// Appearance first so a denial is localized: until the pipeline reads the settings it
// resolves from the Level B defaults, the theme query and the locale cookie, nothing private.
export const appearance: Handle = async ({ event, resolve }) => {
  event.locals.settings = defaultSettings;
  event.locals.setupUnlocked = false;
  applyAppearance(event);

  return resolve(event, {
    transformPageChunk: ({ html }) => {
      const { theme, mode, accent } = appearanceOf(event);
      const { faviconMediaId, density } = event.locals.settings;
      // Site media is private (§7): only a member's page links the uploaded favicon.
      const favicon =
        event.locals.member && faviconMediaId
          ? `/api/v1/media/${faviconMediaId}/image`
          : STATIC_FAVICON;
      return html
        .replaceAll(PLACEHOLDER.theme, theme)
        .replaceAll(PLACEHOLDER.mode, mode)
        .replaceAll(PLACEHOLDER.density, density)
        .replaceAll(PLACEHOLDER.lang, event.locals.locale)
        .replaceAll(PLACEHOLDER.accent, accentCss(accent, mode))
        .replaceAll(PLACEHOLDER.favicon, favicon);
    },
  });
};
