import { contrastRatio } from './contrast';
import type { RenderedMode } from './theme-tokens';

export type AccentConfig = { light?: string; dark?: string } | null;

// R-UI-02/04: a validated per-mode accent (#rrggbb, checked in the config schema) overrides
// the theme's accent tokens; the text colour on it is whichever of white or black reads
// better, so a custom accent never needs a hand-picked pair.
function declarations(accent: string): string {
  const on =
    contrastRatio(accent, '#ffffff') >= contrastRatio(accent, '#000000') ? '#ffffff' : '#000000';
  return `--color-accent: ${accent}; --color-accent-contrast: ${on};`;
}

// Returns the text of a <style> element for <head>. A stylesheet rather than an inline
// style so 'system' can put the dark accent under prefers-color-scheme (no flash). The
// selector out-ranks the theme files'; values are validated hex only.
export function accentCss(accent: AccentConfig, mode: RenderedMode): string {
  if (accent === null) return '';
  const root = ':root[data-theme][data-mode]';
  if (mode === 'light' || mode === 'dark') {
    const colour = accent[mode];
    return colour ? `${root} { ${declarations(colour)} }` : '';
  }
  const parts: string[] = [];
  if (accent.light) parts.push(`${root} { ${declarations(accent.light)} }`);
  if (accent.dark) {
    parts.push(`@media (prefers-color-scheme: dark) { ${root} { ${declarations(accent.dark)} } }`);
  }
  return parts.join('\n');
}
