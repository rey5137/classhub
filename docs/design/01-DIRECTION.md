# 01 — Visual direction

**Status:** chosen by the owner, 2026-11-05. **Spec refs:** `app/10` (R-UI-05…12), `app/03` (routes), PRODUCT.md.
**Read when:** building or styling any screen, a theme file, or a primitive (slice 0c onward).
**Reference build:** a static prototype of the shell and the five member areas, kept in the private design workspace (`.impeccable/mocks/proto/`).

The owner's own class reunion site is the reference, not a template: its school-uniform blue and its warmth carry
over, its landing-page structure does not. **Nostalgic in look, modern in use.** Shipped content stays synthetic
(INV-6); a class's own name, years, logo and banner come in through `/admin` (R-UI-01).

## 1. The world

- **Thesis:** the class is a wall of rows you browse one axis at a time (the reunion, new photos, each school
  year, the classmates), written in ballpoint on white like the tracklist of a mixtape someone made in 2006.
- **How it was chosen:** after two rounds the owner fused the UX of a streaming title wall (rows, focus-grow,
  dimming) with the light tone of a cassette j-card (white inlay, ballpoint blue, one red stripe, hand-lettered
  heads), in light and dark.
- **Refuses:** a social feed (Facebook/Zalo), a SaaS dashboard, school-kid cuteness (stickers, doodles), heavy or
  dense screens, eyebrow labels and section numbers.
- **Mode:** Operate. The world lends type, palette, density and the signature interaction; navigation and controls
  are standard web components (R-UI-09).

## 2. Signature moves

1. **Focus-grow.** Photos and albums sit in horizontal rails (`Row` > `Rail` > `Tile`, 4:3, scroll-snap). The tile
   under the pointer or keyboard focus grows (156 → 236 px on phones, 220 → 340 px on desktop) and reveals its title
   and uploader; while one row is focused the other rows dim to `--color-dim`. 150 ms ease-out; instant under
   `prefers-reduced-motion`. The newest item may start grown (`.grow`).
2. **The spine stripe.** A 5 px `--color-mark` stripe beside the class name in the top bar, like the spine of a
   tape. `--color-mark` appears in only two other places: the `mới` pill on the single newest thing per row, and
   the focus ring. Never a fill, never body text.
3. **Hand-lettered heads.** Page titles and row heads are set in Patrick Hand in `--color-accent` (ballpoint ink);
   everything read or operated is Be Vietnam Pro. Dates and times sit right-aligned in tabular figures, like running
   times on a tracklist.

## 3. Type

Bundled woff2 files (R-UI-07), both SIL OFL, with the Vietnamese subset:

- **Be Vietnam Pro** (400, 500, 600, 700) for everything read or operated.
- **Patrick Hand** (400) for page titles, row heads and the class name in the brand lock-up only; never for body,
  controls or chat. `minimal` replaces it with Be Vietnam Pro 700/600.

| Token | Size / line | Face | Use |
|---|---|---|---|
| `--text-display` | 2.125 / 1.15 (2.875 at ≥ 768 px) | Patrick Hand | page title (`h1`) |
| `--text-title` | 1.625 / 1.2 | Patrick Hand | row heads (`h2`) |
| `--text-heading` | 1.25 / 1.3 | Be Vietnam Pro 600 | sheet titles (the reunion) |
| `--text-body` | 1 / 1.6 | Be Vietnam Pro 400 | body, chat, list titles (600) |
| `--text-small` | 0.875 / 1.5 | Be Vietnam Pro 400–600 | meta, times, captions, chips, tab labels (0.75, 600) |

Nothing read is below 16 px except meta, captions and tab labels; nothing interactive is below 14 px.

## 4. Themes

Every theme sets only the R-UI-05 contract plus `--color-mark`, `--color-mark-contrast`, `--color-dim` and the two
font tokens. All pairs below were measured (text 4.5:1, controls and focus 3:1); the 0c contrast test repeats it.

### `yearbook` (default): uniform pale blue, ballpoint ink

| Token | Light | Dark (school-night navy) |
|---|---|---|
| `--color-bg` | `#f0f9fd` | `#0d1a29` |
| `--color-surface` | `#ffffff` | `#13243a` |
| `--color-surface-2` | `#e4f0f8` | `#1b3250` |
| `--color-text` | `#26404f` (10.2:1) | `#eaf1f6` (15.4:1) |
| `--color-muted` | `#4f6b7b` (5.3:1) | `#a3b8c8` (8.6:1) |
| `--color-accent` | `#1f4f9c` (7.4:1) | `#8cc4ef` (9.4:1) |
| `--color-accent-contrast` | `#ffffff` | `#0d1a29` |
| `--color-border` | `#6b8fa6` (3.2:1) | `#6f8fa8` (4.6:1) |
| `--color-divider` | `#d3e6f1` | `#22395a` |
| `--color-mark` / `-contrast` | `#d9302f` / `#ffffff` | `#ff6b5e` / `#1a0d0b` |
| `--color-focus` | `#d9302f` | `#ff6b5e` |
| `--color-danger` / `--color-success` | `#c0262a` / `#2f7d4f` | `#ff7b70` / `#4fc08d` |
| `--color-dim` | `0.5` | `0.45` |
| `--radius-card` / `--radius-control` | `12px` / `8px` | same |
| `--shadow-card` | `none` | `none` |

### `minimal`: plain

Be Vietnam Pro only. Light: bg `#f6f7f8`, surface `#ffffff`, surface-2 `#eef0f3`, text `#1f2937`, muted `#5b6472`,
accent `#1d4ed8`, border `#7b8494`, divider `#e3e6ea`, mark `#b91c1c`, focus = accent. Dark: bg `#111318`, surface
`#1a1d24`, surface-2 `#232733`, text `#e5e7eb`, muted `#9aa3b2`, accent `#7fb0ff` (contrast `#111318`), border
`#6b7488`, divider `#2a2f3a`, mark `#f87171`. Radii `10px` / `6px`.

### `night`: summer night, dark only

Ignores display mode (R-UI-06). bg `#14121f`, surface `#1d1a2b`, surface-2 `#272338`, text `#f2e9dc`, muted
`#a89fb8`, accent `#ff8a6b` (contrast `#14121f`), border `#8a809f`, divider `#2e2942`, mark and focus `#ffc65c` (a
street-lamp amber). Same faces and radii as `yearbook`.

## 5. Shell

- **Top bar** (56 px phone, 64 px desktop) on `--color-surface` with a 1 px divider: spine stripe + class name in
  hand lettering + years, then (desktop only) the five areas as text links with a 2 px accent underline on the current
  one, then the member's avatar (opens the account menu; Admin lives there).
- **Bottom tab bar** (< 768 px): five areas, drawn icons above 12 px labels, current in accent with a 2 px top rule,
  each target ≥ 44 px. Areas: Trang chủ, Kỷ niệm, Thảo luận, Trò chuyện, Bạn học.
- **Content** column `--content-max: 75rem`; rails bleed to the screen edge on phones.
- **Sheets** (`--color-surface`, 1 px `--color-divider`, `--radius-card`) hold lists and the reunion; no shadows,
  no nested sheets.

## 6. Per area

- **Home:** greeting title ("Chào {name}, lớp mình đây.") with what changed since the last visit; the reunion sheet
  (date, place, who's coming, "Tôi đến" + "Chưa chắc"), beside the title on desktop; rows: Ảnh mới, Đang bàn (list
  sheet) beside Bạn học (portrait rail), then one row per recent school year or album.
- **Memories (Kỷ niệm):** title with counts and "Thêm ảnh"; year chips and a Theo hàng / Lưới switch; rows per
  album with focus-grow, or a whole-cell grid (2 columns on phones, 5 on desktop, 2 px gutters).
- **Discussions (Thảo luận):** one list sheet: pinned first (`GHIM` in accent), title, author · replies, last
  activity right-aligned; "Viết bài" as the primary action.
- **Chat (Trò chuyện):** 760 px column; day separators; others' bubbles in `--color-surface-2` with name · time,
  own bubbles in `--color-accent` on the right; the composer is fixed above the tab bar.
- **Members (Bạn học):** search field; a grid of sheets with portrait, name, city (only what the viewer may see,
  R-PROF-04); "chưa vào" count shown to admins only.
- **Admin, profile, locked, denied:** plain Operate screens with a hand-lettered title only; no rails, no mark.

## 7. Not carried over from the reference

The landing-page structure (hero photo, long sections, ribbon timeline), Google Sheets integration, hosted Google
Fonts, Playfair display titles, numbered eyebrows, 10–14 px body text, and the light-blue button fill (3.2:1). The
class's photos, crest and names are the owner's content, entered through `/admin`.
