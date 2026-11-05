import { themeTokens, type RenderedMode, type ThemeId, type ThemeMode } from './theme-tokens';

export interface ThemeDefinition {
  id: ThemeId;
  modes: ThemeMode[];
  defaultMode: ThemeMode;
}

// R-UI-03/R-UI-06: the only place a theme id is admitted.
export const themes: Record<ThemeId, ThemeDefinition> = {
  yearbook: { id: 'yearbook', modes: ['light', 'dark'], defaultMode: 'light' },
  minimal: { id: 'minimal', modes: ['light', 'dark'], defaultMode: 'light' },
  night: { id: 'night', modes: ['dark'], defaultMode: 'dark' },
};

export const themeIds = Object.keys(themes) as ThemeId[];
export const defaultThemeId: ThemeId = 'yearbook';

export function isThemeId(value: string): value is ThemeId {
  return Object.hasOwn(themes, value);
}

export function resolveMode(theme: ThemeId, requested: RenderedMode): RenderedMode {
  if (theme === 'night') return 'dark';
  return requested === 'system' || themes[theme].modes.includes(requested)
    ? requested
    : themes[theme].defaultMode;
}

export function tokensFor(theme: ThemeId, mode: ThemeMode) {
  const resolved = resolveMode(theme, mode);
  return themeTokens[theme][resolved === 'system' ? 'light' : resolved];
}
