export type ThemeId = 'yearbook' | 'minimal' | 'night';
export type ThemeMode = 'light' | 'dark';
export type RenderedMode = ThemeMode | 'system';

export interface ThemeTokens {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  muted: string;
  accent: string;
  accentContrast: string;
  border: string;
  divider: string;
  mark: string;
  markContrast: string;
  focus: string;
  danger: string;
  warning: string;
  success: string;
  dim: string;
  radiusCard: string;
  radiusControl: string;
}

// The token values from docs/design/01-DIRECTION.md §4 and the R-UI-05 contract.
// The theme CSS files are the shipped source; tests assert these values match.
export const themeTokens: Record<ThemeId, Partial<Record<ThemeMode, ThemeTokens>>> = {
  yearbook: {
    light: {
      bg: '#f0f9fd',
      surface: '#ffffff',
      surface2: '#e4f0f8',
      text: '#26404f',
      muted: '#4f6b7b',
      accent: '#1f4f9c',
      accentContrast: '#ffffff',
      border: '#6b8fa6',
      divider: '#d3e6f1',
      mark: '#d9302f',
      markContrast: '#ffffff',
      focus: '#d9302f',
      danger: '#c0262a',
      warning: '#8a5a00',
      success: '#2f7d4f',
      dim: '0.5',
      radiusCard: '12px',
      radiusControl: '8px',
    },
    dark: {
      bg: '#0d1a29',
      surface: '#13243a',
      surface2: '#1b3250',
      text: '#eaf1f6',
      muted: '#a3b8c8',
      accent: '#8cc4ef',
      accentContrast: '#0d1a29',
      border: '#6f8fa8',
      divider: '#22395a',
      mark: '#ff6b5e',
      markContrast: '#1a0d0b',
      focus: '#ff6b5e',
      danger: '#ff7b70',
      warning: '#f2b45e',
      success: '#4fc08d',
      dim: '0.45',
      radiusCard: '12px',
      radiusControl: '8px',
    },
  },
  minimal: {
    light: {
      bg: '#f6f7f8',
      surface: '#ffffff',
      surface2: '#eef0f3',
      text: '#1f2937',
      muted: '#5b6472',
      accent: '#1d4ed8',
      accentContrast: '#ffffff',
      border: '#7b8494',
      divider: '#e3e6ea',
      mark: '#b91c1c',
      markContrast: '#ffffff',
      focus: '#1d4ed8',
      danger: '#b91c1c',
      warning: '#92400e',
      success: '#15803d',
      dim: '0.5',
      radiusCard: '10px',
      radiusControl: '6px',
    },
    dark: {
      bg: '#111318',
      surface: '#1a1d24',
      surface2: '#232733',
      text: '#e5e7eb',
      muted: '#9aa3b2',
      accent: '#7fb0ff',
      accentContrast: '#111318',
      border: '#6b7488',
      divider: '#2a2f3a',
      mark: '#f87171',
      markContrast: '#111318',
      focus: '#7fb0ff',
      danger: '#f87171',
      warning: '#fbbf24',
      success: '#4ade80',
      dim: '0.45',
      radiusCard: '10px',
      radiusControl: '6px',
    },
  },
  night: {
    dark: {
      bg: '#14121f',
      surface: '#1d1a2b',
      surface2: '#272338',
      text: '#f2e9dc',
      muted: '#a89fb8',
      accent: '#ff8a6b',
      accentContrast: '#14121f',
      border: '#8a809f',
      divider: '#2e2942',
      mark: '#ffc65c',
      markContrast: '#14121f',
      focus: '#ffc65c',
      danger: '#ff8a6b',
      warning: '#ffc65c',
      success: '#7dd3a8',
      dim: '0.45',
      radiusCard: '12px',
      radiusControl: '8px',
    },
  },
};

export const CSS_VAR_BY_TOKEN: Record<keyof ThemeTokens, string> = {
  bg: '--color-bg',
  surface: '--color-surface',
  surface2: '--color-surface-2',
  text: '--color-text',
  muted: '--color-muted',
  accent: '--color-accent',
  accentContrast: '--color-accent-contrast',
  border: '--color-border',
  divider: '--color-divider',
  mark: '--color-mark',
  markContrast: '--color-mark-contrast',
  focus: '--color-focus',
  danger: '--color-danger',
  warning: '--color-warning',
  success: '--color-success',
  dim: '--color-dim',
  radiusCard: '--radius-card',
  radiusControl: '--radius-control',
};
