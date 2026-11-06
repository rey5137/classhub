# 10 — Themes, customization, language and accessibility

**Covers:** The three customization levels, `site.config.ts`, the CSS token contract, the shipped themes, UI primitives, i18n, accessibility.
**Read when:** touching styles, a component, site settings, copy or a translation.
**Owns:** `R-UI-*`, `AC-UI-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§10.n` is in this file.

---

## 10.1 Customization levels

- **R-UI-01** **Level A, admin settings (no code), stored in D1 `site_settings`:** site name, class years,
  description, welcome message, banner photo, logo and favicon (uploaded through §7 as `media_type = "site"`, kept
  out of the gallery), theme preset, display mode (light, dark, system), accent colour, card density (comfortable,
  compact), default language, and feature toggles for memories, discussions and chat.
- **R-UI-02** **Level B, project configuration (`site.config.ts`, one validated object):** navigation order,
  default locale, default time zone, visible profile fields, app name, upload limits, quota thresholds, default
  theme, chat retention, messaging-host allow-list. Every service reads it through `src/lib/config/` only; no default
  is duplicated elsewhere.
- **R-UI-03** **Level C, developer themes:** a new `src/lib/themes/<id>.css` that sets only contract tokens (§10.2)
  under `[data-theme='<id>']`, registered in `src/lib/themes/registry.ts`. Pages are never forked for styling.
- **R-UI-04** Settings are validated with a strict Zod schema: theme ids from the registry, colours as `#rrggbb`
  with the accent set per mode (`accent: { light?, dark? }`), each key checked for WCAG AA contrast (4.5:1) against
  the theme's surface in its own mode (refused with the measured ratio otherwise; a key for a mode the theme does
  not ship is refused). The server render applies the accent of the rendered mode, and for `system` both, the dark
  one under `prefers-color-scheme: dark`. Text fields length-bounded. Arbitrary CSS, HTML or JavaScript is never accepted. Disabling a
  feature never deletes its data (R-NAV-02).

```ts
// site.config.ts — public defaults, no secrets
export const siteDefaults = {
  name: 'Our Class',
  years: '20XX–20YY',
  locale: 'vi',
  theme: 'yearbook',
  features: { memories: true, discussions: true, chat: true },
  limits: { mediaWarnBytes: 8_000_000_000, mediaStopBytes: 9_000_000_000, photosPerDay: 25 },
  chat: { retainDays: 365, maxMessages: 30_000 }
} as const;
```

## 10.2 Token contract and themes

- **R-UI-05** **Tokens** (`src/lib/themes/tokens.css`): `--color-bg`, `--color-surface`, `--color-surface-2`,
  `--color-text`, `--color-muted`, `--color-accent`, `--color-accent-contrast`, `--color-border`, `--color-danger`,
  `--color-warning`, `--color-success`, `--color-focus`, `--radius-card`, `--radius-control`, `--space-unit`,
  `--content-max`, `--font-body`, `--font-heading`, `--shadow-card`, `--density`, `--color-divider` (decorative
  rules, not a control boundary), `--color-mark` (the brand mark and "new" marker only, never body text) and the type
  scale `--text-display|title|heading|body|small` (`docs/design/01-DIRECTION.md` §3). Components use tokens only: no
  raw colours or font stacks outside theme files (lint-checked).
- **R-UI-06** **Shipped themes:** `yearbook` (the default: school-uniform pale blue, ballpoint-blue ink,
  one red mark, hand-lettered titles), `minimal` (neutral, one face), `night` (summer night, dark by design); token values in
  `docs/design/01-DIRECTION.md` §4. `minimal` and `yearbook` define light and dark; `night` is dark only and ignores display
  mode. Each pair meets WCAG AA for text and UI components.
- **R-UI-07** Fonts are system stacks or files bundled in the repo; no third-party font requests (R-AUTH-24). The
  shipped faces are Be Vietnam Pro and Patrick Hand (SIL OFL, woff2 with the Vietnamese subset); body text is
  never below 16 px.
- **R-UI-08** The active theme and mode are applied server-side as `data-theme` and `data-mode` on `<html>`, so the
  first paint is themed with no flash.

## 10.3 Primitives

- **R-UI-09** Every screen is built from shared primitives in `src/lib/components/`: `AppShell`, `PageHeader`,
  `Card`, `Avatar`, `GalleryGrid`, `PostCard`, `FormField`, `Button`, `EmptyState`, `Dialog`, `Toast`, `Banner`,
  `Pager`. A screen-specific component composes primitives and adds no new colours or spacing scales.

## 10.4 Language

- **R-UI-10** All user-visible strings live in message dictionaries `src/lib/i18n/vi.ts` and `en.ts`, keyed by area
  (`nav.`, `home.`, `mem.`, `brd.`, `chat.`, `prof.`, `admin.`, `err.`). A key missing from either locale fails the
  check. The default locale comes from settings (`vi` in the shipped defaults); a member may pick theirs in `/profile`
  (stored in `localStorage`, `classhub.locale`, and mirrored in the first-party `classhub.locale` cookie:
  `Path=/; Max-Age=31536000; SameSite=Lax`, with `Secure` on HTTPS). The server render reads the cookie and validates
  it against the known locales; an unknown value uses the site default. The initial dictionary and `<html lang>`
  use this locale so the chosen language renders before JavaScript runs, without a language flash or hydration mismatch.
- **R-UI-11** Dates and numbers use `Intl` with the active locale; times show in the viewer's time zone. The root
  layout mirrors the browser's IANA zone in the first-party `tz` cookie (`Path=/; Max-Age=31536000; SameSite=Lax`,
  with `Secure` on HTTPS) whenever it differs from the zone the page was rendered in, then reloads its data once. The
  server render validates the cookie with `Intl.DateTimeFormat`; absent or unknown, it uses the Level B `timeZone`
  (`Asia/Ho_Chi_Minh` in the shipped defaults). "Today" in a list is that zone's day.

## 10.5 Accessibility

- **R-UI-12** WCAG 2.2 AA target: keyboard operation for everything, a visible focus ring from `--color-focus`,
  alt text (caption, else *Photo by <name>*), labelled form fields with error text tied by `aria-describedby`, dialog
  focus trap and return, live-region announcements for toasts and new chat messages (polite, throttled), touch targets
  ≥ 44 px, `prefers-reduced-motion` and `forced-colors` respected.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-UI-01 | Switching theme from `/admin` changes every screen's look and no content or markup | R-UI-01, 03, 08 | e2e DOM snapshot equality across themes |
| AC-UI-02 | Each theme × mode passes axe with no serious or critical issue on every route at 390 and 1280 px | R-UI-06, 12 | e2e (axe) |
| AC-UI-03 | Screenshots of every route in each theme × mode at 390 and 1280 px are produced for release review | R-UI-06 | `npm run screenshots` |
| AC-UI-04 | A per-mode accent with contrast under 4.5:1 on its own mode's surface, a key for a mode the theme lacks, an unknown theme id and a CSS string are refused | R-UI-04 | unit |
| AC-UI-05 | No component file contains a raw colour or font stack | R-UI-05 | lint (stylelint rule) |
| AC-UI-06 | Every i18n key exists in `vi` and `en` | R-UI-10 | unit |
| AC-UI-07 | A new theme file with only tokens works without touching any component | R-UI-03 | e2e with a fixture theme |
