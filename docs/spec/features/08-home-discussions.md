# 08 — Home, info pages and discussions

**Covers:** Home, admin-edited info pages and notices, the board, threads and comments, Markdown rendering, moderation.
**Read when:** touching Home, info pages, posts, comments, the Markdown renderer or moderation.
**Owns:** `R-BRD-*`, `AC-BRD-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§8.n` is in this file.

---

## 8.1 Home and info pages

- **R-BRD-01** Home shows, in order: the welcome block (site name, class years, welcome message and banner photo from
  settings, §10.1); pinned info pages and pinned threads; reunion details (an info page with slug `reunion`, shown as a
  card with date, place and a map link when filled); the 12 newest photos; the 5 most recently active
  unpinned threads (pinned ones are already listed above).
- **R-BRD-02** Admins create, edit, pin, order and delete info pages (`slug` 1–40 of `[a-z0-9-]`, title ≤ 160, body
  Markdown ≤ 20,000). Each is reachable at `/info/[slug]`.

## 8.2 Markdown

- **R-BRD-03** **A small Markdown subset:** paragraphs, line breaks, bold, italic, links, bulleted and numbered lists,
  block quotes, inline code. No headings above level 3, images, HTML, tables or embeds. Rendering happens on the
  server into HTML that a strict allow-list sanitizer (tags `p br strong em a ul ol li blockquote code h3`, attribute
  `href` only) cleans; links get `rel="noopener noreferrer nofollow"`, and only `https:`, `mailto:` and same-origin
  relative URLs survive. Both must run without a DOM in the Worker.
- **R-BRD-04** An internal photo reference `[[photo:<media-id>]]` renders as the photo's thumbnail linking to
  `/memories/<id>`, after a visibility check; a deleted or unknown id renders the placeholder (R-MEM-20).

## 8.3 Threads and comments

- **R-BRD-05** Limits: title 1–160, post body 1–10,000, comment 1–2,000 characters (after trimming).
- **R-BRD-06** The board lists pinned threads first, then by `last_activity_at` descending, 20 per page, keyset
  paged. A new comment updates the thread's `last_activity_at` and `comment_count` in the same batch (R-DB-08).
- **R-BRD-07** Comments are one level, oldest first, 20 per page. A locked thread accepts no new comments (admins
  included, until unlocked) and says so.
- **R-BRD-08** Authors edit and delete their own posts and comments; an edit shows *edited*; a delete is soft and
  shows *deleted* in place when other comments follow it. Admins can edit, delete, pin and lock anything; each
  moderation action writes an `audit_events` row without content.
- **R-BRD-09** **History is kept indefinitely:** no automatic retention for posts or comments.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-BRD-01 | A corpus of hostile Markdown (script tags, `javascript:` links, `onerror`, raw HTML, data URIs, nested quotes) renders to allow-listed HTML only | R-BRD-03 | unit, run in the Workers pool |
| AC-BRD-02 | Pinned threads come first and pagination is stable across 5,000 threads | R-BRD-06 | integration |
| AC-BRD-03 | A comment on a locked thread is refused; unlocking allows it | R-BRD-07 | integration |
| AC-BRD-04 | Members can't edit or delete others' content; admins can, and an audit row is written | R-BRD-08 | integration |
| AC-BRD-05 | Home shows pinned info, reunion details, newest photos and active threads for the demo seed | R-BRD-01 | e2e |
| AC-BRD-06 | Over-length titles, bodies and comments are refused with field errors | R-BRD-05 | unit |
