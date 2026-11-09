# Themes

Class Hub ships three themes. A theme is a set of CSS custom properties; no component changes between them. The
admin picks the site theme on `/admin`, and a member can switch their own theme and mode from `/profile`.

## The shipped themes

| Theme | Look | Modes |
|---|---|---|
| `yearbook` | The default: school-uniform pale blue, ballpoint-blue ink, one red mark, hand-lettered titles | light, dark |
| `minimal` | Neutral, one face, quiet spacing | light, dark |
| `night` | Summer night, dark by design; it ignores display mode | dark |

The rules are in `docs/spec/app/10-themes-i18n.md` (R-UI-05, R-UI-06, R-UI-08):

- Every theme defines the same tokens: the colours (`--color-bg`, `--color-surface`, `--color-surface-2`,
  `--color-text`, `--color-muted`, `--color-accent`, `--color-accent-contrast`, `--color-border`, `--color-divider`,
  `--color-mark`, `--color-mark-contrast`, `--color-focus`, `--color-danger`, `--color-warning`, `--color-success`),
  the radii (`--radius-card`, `--radius-control`), the fonts it uses, and `--color-dim`. Despite its name,
  `--color-dim` is an opacity value (a number), not a colour: it sets how far dimmed content fades.
  `--color-heading` defaults to `--color-accent` in `tokens.css`. Check the exact list against
  `src/lib/themes/theme-tokens.ts` and spec R-UI-05 before you add a theme.
- `yearbook` and `minimal` define light and dark. `night` is dark only and ignores the requested mode.
- Each theme × mode pair meets WCAG AA for text and UI components.
- The active theme and mode are written as `data-theme` and `data-mode` on `<html>` by the server, so the first paint
  is already themed.
- Components use tokens only. A raw colour or font stack outside a theme file fails the stylelint rule (AC-UI-05).

## Where the tokens live

- `src/lib/themes/tokens.css`: the shared contract and type scale, plus the non-theme palettes (photo placeholders,
  avatar tones).
- `src/lib/themes/yearbook.css`, `minimal.css`, `night.css`: one file per theme. The light values are the base block
  (`[data-theme='…']`); dark overrides use `[data-theme='…'][data-mode='dark']`, and `data-mode='system'` follows the
  OS with the same values.
- `src/app.css`: imports `tokens.css` and the three theme files.
- `src/lib/themes/theme-tokens.ts`: the typed token values, the `ThemeId` union and the token-to-CSS-variable map.
  `tests/unit/theme-contrast.test.ts` asserts that these values match the CSS and meet the contrast rules.
- `src/lib/themes/registry.ts`: the admitted theme ids, their modes and default mode, and the helpers that resolve a
  theme, a mode and the browser-chrome colour.
- `src/lib/themes/accent.ts` and `contrast.ts`: the per-mode accent check and the contrast maths.
- `src/lib/server/appearance.ts`: resolves the requested theme/mode for the server render.

## Add a theme

1. Add the id to the `ThemeId` union in `src/lib/themes/theme-tokens.ts`.
2. Add its values to `themeTokens` in the same file, for every mode it supports.
3. Create `src/lib/themes/<id>.css` with a `[data-theme='<id>']` block and, when it has a dark mode, the
   `[data-mode='dark']` and `[data-mode='system']` blocks. Import it in `src/app.css`.
4. Add the theme to `themes` in `src/lib/themes/registry.ts` with its `modes` and `defaultMode`. `themeIds` follows
   the record, so the settings schema, the admin screen and the manifest accept it.
5. Run `npm run test` (the contrast and appearance tests cover the new pair) and `npm run screenshots` to review every
   route in the new theme.

A theme file that defines only tokens works without touching a component (AC-UI-07).
