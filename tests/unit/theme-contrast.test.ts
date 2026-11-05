import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, formatRatio } from '../../src/lib/themes/contrast';
import { CSS_VAR_BY_TOKEN, themeTokens, type ThemeTokens } from '../../src/lib/themes/theme-tokens';

const cssFiles = ['yearbook', 'minimal', 'night'] as const;

const palette = declarations(
  readFileSync(new URL('../../src/lib/themes/tokens.css', import.meta.url), 'utf8'),
  ':root',
);

function declarations(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`Missing selector ${selector}`);
  const values: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(';')) {
    const [property, ...rest] = line.split(':');
    if (!property || rest.length === 0) continue;
    values[property.trim()] = rest.join(':').trim();
  }
  return values;
}

function cssFor(theme: (typeof cssFiles)[number]): string {
  return readFileSync(new URL(`../../src/lib/themes/${theme}.css`, import.meta.url), 'utf8');
}

describe('R-UI-06 theme CSS matches the token values', () => {
  it.each(cssFiles)('%s declares every token exactly once per mode', (theme) => {
    const css = cssFor(theme);
    const modes = theme === 'night' ? ['dark'] : ['light', 'dark'];
    for (const mode of modes) {
      // Light values live in the base block; dark overrides cascade on top.
      const base = theme === 'night' ? {} : declarations(css, `[data-theme='${theme}']`);
      const override =
        theme === 'night'
          ? declarations(css, `[data-theme='night']`)
          : mode === 'dark'
            ? declarations(css, `[data-theme='${theme}'][data-mode='dark']`)
            : {};
      const declarationsInBlock = { ...base, ...override };
      const expected = themeTokens[theme][mode as 'light' | 'dark'];
      expect(expected).toBeDefined();
      for (const [token, variable] of Object.entries(CSS_VAR_BY_TOKEN)) {
        expect(declarationsInBlock[variable], `${theme} ${mode} ${variable}`).toBe(
          expected?.[token as keyof ThemeTokens],
        );
      }
    }
  });
});

const textPairs: Array<[keyof ThemeTokens, keyof ThemeTokens]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface2'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface2'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'surface2'],
  ['accentContrast', 'accent'],
  ['markContrast', 'mark'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['warning', 'bg'],
  ['warning', 'surface'],
  ['success', 'bg'],
  ['success', 'surface'],
];

const uiPairs: Array<[keyof ThemeTokens, keyof ThemeTokens]> = [
  ['border', 'bg'],
  ['border', 'surface'],
  ['focus', 'bg'],
  ['focus', 'surface'],
];

describe('R-UI-06 every theme × mode meets WCAG AA', () => {
  for (const [theme, modes] of Object.entries(themeTokens)) {
    for (const [mode, tokens] of Object.entries(modes)) {
      if (!tokens) continue;
      for (let tone = 1; tone <= 10; tone += 1) {
        it(`${theme} ${mode} avatar ${tone} text meets 4.5:1`, () => {
          expect(
            contrastRatio(palette['--avatar-ink']!, palette[`--avatar-${tone}`]!),
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const [foreground, background] of textPairs) {
        it(`${theme} ${mode} ${foreground} on ${background} is at least 4.5:1`, () => {
          const ratio = contrastRatio(tokens[foreground], tokens[background]);
          expect(
            ratio,
            `${theme} ${mode} ${foreground}/${background} = ${formatRatio(ratio)}`,
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const [foreground, background] of uiPairs) {
        it(`${theme} ${mode} ${foreground} on ${background} is at least 3:1`, () => {
          const ratio = contrastRatio(tokens[foreground], tokens[background]);
          expect(
            ratio,
            `${theme} ${mode} ${foreground}/${background} = ${formatRatio(ratio)}`,
          ).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }
});

describe('R-UI-02 system mode follows the dark tokens', () => {
  it.each(['yearbook', 'minimal'] as const)('%s system block repeats the dark values', (theme) => {
    const css = cssFor(theme);
    const dark = declarations(css, `[data-theme='${theme}'][data-mode='dark']`);
    const system = declarations(css, `[data-theme='${theme}'][data-mode='system']`);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(Object.keys(dark).length).toBeGreaterThan(5);
    expect(system).toEqual(dark);
  });
});
