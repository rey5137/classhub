# 01 — Visual direction

**Status:** pinned by the owner, 2026-11-05. **Spec refs:** `app/10` (R-UI-05…12), `app/03` (routes), PRODUCT.md.
**Read when:** building or styling any screen, a theme file, or a primitive (slice 0c onward).

The owner pinned the look of their own class's reunion site as Class Hub's direction. Its world (the school uniform,
the flame tree in bloom, a two-voice serif heading) is carried into an app; its weaknesses (small text, a light blue
that fails contrast) are fixed here. Shipped content stays synthetic (INV-6); a class's own name, years, logo and
banner come in through `/admin` (R-UI-01).

## 1. The world

- **Thesis:** the class's place reads like the school it came from: the pale blue of the uniform shirt, the red of the
  phượng flowering on the last day, and headings that speak in two voices, a plain statement and its italic answer
  (*Ảnh thì cũ. Kỷ niệm vẫn nguyên.*).
- **Refuses:** a social feed (Facebook/Zalo), a SaaS dashboard, school-kid cuteness (stickers, doodles), heavy imagery.
- **Mode:** Operate. The world lends type, palette, density and the signature moves below; navigation and controls are
  standard web components (R-UI-09).

## 2. Signature moves

1. **The two-voice heading.** A page title is one line in Be Vietnam Pro or Playfair roman, with an optional second line in
   Playfair Display italic (`PageHeader` has `title` and `echo`). Used on Home, Memories, Discussions, Members and the
   empty states; never on Admin, forms, or chat.
2. **Numbered eyebrows.** Each section of a screen carries a tracked small-caps label with its number:
   `01 / ẢNH MỚI`, `02 / ĐANG BÀN`. Numbers follow the navigation order from `site.config.ts`, so the same area has the
   same number everywhere: the class's own table of contents.
3. **The phượng mark.** One authored SVG blossom (five petals, one with a pale streak), drawn in `--color-mark`, sits
   on the class-year numeral in the brand lock-up and marks the one item that is new since the member's last visit.
   At most one blossom per viewport; never as a pattern, background or bullet.

## 3. Type

Faces are bundled woff2 files (R-UI-07), both SIL OFL, with the Vietnamese subset:

- **Be Vietnam Pro** (400, 500, 600, 700) for everything that is read or operated. Designed for Vietnamese; its
  diacritics stack cleanly at small sizes.
- **Playfair Display** (500 roman, 500 italic) for display only: page titles, their echo line, the class-year numeral.

One fixed scale, nothing in between (rem at 16 px root):

| Token | Size / line | Face | Use |
|---|---|---|---|
| `--text-display` | 2.75 / 1.1 (3.5 at ≥ 1024 px) | Playfair 500 | Home title, class-year numeral |
| `--text-title` | 1.875 / 1.2 | Playfair 500 | page titles and echo line |
| `--text-heading` | 1.25 / 1.35 | Be Vietnam Pro 600 | card and section headings |
| `--text-body` | 1 / 1.6 | Be Vietnam Pro 400 | body, chat, comments (never below 16 px) |
| `--text-small` | 0.875 / 1.5 | Be Vietnam Pro 500 | meta (author · time), captions |
| `--text-eyebrow` | 0.75 / 1.4, tracking 0.14em, caps | Be Vietnam Pro 700 | numbered eyebrows, tab labels |

The reference site's 10–14 px body and labels are not carried over: body is 16 px, nothing interactive is under 14 px.

## 4. Themes

All three set only the R-UI-05 contract tokens, plus `--color-mark` (the phượng colour) and the two font tokens.
Ratios are measured against the token's own ground and checked again by the 0c contrast test.

### `yearbook`: the uniform (default)

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--color-bg` | `#f0f9fd` | `#0e1b2a` | uniform pale blue / school-night navy |
| `--color-surface` | `#ffffff` | `#15263a` | cards, sheets |
| `--color-surface-2` | `#e4f2fa` | `#1c3149` | selected rows, chat bubbles of others |
| `--color-text` | `#344956` | `#e8eef3` | 8.8:1 / 14.9:1 |
| `--color-muted` | `#526e7e` | `#9fb4c4` | 5.1:1 / 8.1:1 |
| `--color-accent` | `#176fb0` | `#5fb3e6` | buttons, links, active tab; the reference's `#229bd0` (3.2:1) is not used for text or fills |
| `--color-accent-contrast` | `#ffffff` | `#0e1b2a` | 5.3:1 / 7.5:1 |
| `--color-border` | `#5f8aa3` | `#7b9bb3` | control outlines, 3.5:1 / 5.9:1 |
| `--color-divider` | `#d6e9f3` | `#24405c` | decorative rules only (not a control boundary) |
| `--color-mark` | `#ed3839` | `#ff6b5e` | phượng mark and "new" only; never body text |
| `--color-danger` | `#c8262a` | `#ff6b5e` | 5.2:1 / 6.2:1 |
| `--color-warning` | `#a15c00` | `#e0a43a` | |
| `--color-success` | `#2f7d4f` | `#3fb37f` | |
| `--color-focus` | `#ed3839` | `#ff6b5e` | 2 px ring, 2 px offset; 3.8:1 / 6.2:1 |
| `--radius-card` / `--radius-control` | `10px` / `6px` | same | |
| `--shadow-card` | `none` | `none` | depth is a 1 px `--color-divider` rule |

### `minimal`: plain

Be Vietnam Pro only (`--font-heading` = `--font-body`), no echo line in italics (the echo renders roman, muted).
Light: bg `#f7f7f8`, surface `#ffffff`, text `#1f2937`, muted `#6b7280`, accent `#1d4ed8`, border `#7b8494`,
mark `#b91c1c`. Dark: bg `#111318`, surface `#1a1d24`, text `#e5e7eb`, muted `#8a94a6`, accent `#60a5fa`
(contrast text `#111318`), border `#6b7488`, mark `#ef4444`. Radii `8px` / `6px`.

### `night`: summer night, dark only

Ignores display mode (R-UI-06). bg `#14121f`, surface `#1d1a2b`, surface-2 `#272338`, text `#f2e9dc` (15.4:1),
muted `#a89fb8` (7.3:1), accent and mark `#ff7a5c` (contrast text `#14121f`, 7.2:1), border `#8a809f` (5.0:1),
divider `#2e2942`. Same faces and radii as `yearbook`.

## 5. Shell

- **Mobile (< 768 px):** a 56 px top bar holds the brand lock-up (class-year numeral with the phượng mark, site name,
  years) and the member's avatar; a bottom tab bar with the five areas (Trang chủ, Kỷ niệm, Thảo luận, Trò chuyện,
  Bạn học) in `--text-eyebrow`, icons above labels, active tab in `--color-accent` with a 2 px top rule. Touch
  targets ≥ 44 px. Admin is reached from the avatar menu.
- **Desktop (≥ 768 px):** one top bar with the lock-up left and the five areas plus avatar right; content column
  `--content-max: 72rem`, photo wall up to the full width.
- **Ground:** pages sit on `--color-bg`; cards on `--color-surface` separated by `--color-divider` rules, no shadows.
- **Motion:** 150 ms ease-out on state changes only; nothing moves on scroll; `prefers-reduced-motion` turns it off.

## 6. Per area

- **Home (`/`):** the class lock-up at display size with the two-voice welcome (from `/admin`), then numbered sections:
  next reunion (date, place, one action), new photos (a strip), active threads, pinned info. This is the only screen
  with a hero, and it is type, not a photo, unless the admin set a banner.
- **Memories:** whole-cell grid (2 columns at 390 px, 4–6 on desktop), square thumbnails, caption and uploader under
  each; album and year filters as standard chips.
- **Discussions:** list rows (title, author, reply count, last activity), pinned first with the eyebrow `GHIM`.
- **Chat:** standard bubbles: own in `--color-accent` with `--color-accent-contrast`, others in `--color-surface-2`;
  no two-voice heading, no blossom.
- **Members:** a list with avatar, display name, city; profile pages show only what the viewer may see (R-PROF-04).
- **Admin, profile, locked, denied:** plain Operate screens: title, forms, tables; no ornament.

## 7. What is not carried over from the reference

The landing-page structure (hero photo, ten long sections, ribbon timeline), Google Sheets integration, hosted Google
Fonts, the hover lift on buttons, 10 px labels and the light-blue button fill. The class's photos, crest and names
are the owner's content and are entered through `/admin`, never committed.
