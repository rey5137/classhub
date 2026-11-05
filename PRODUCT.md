# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Members:** about 5–50 invited classmates of one school class, now in their 30s–40s, roughly 15–25 years after
  graduating. They are comfortable on phones and with everyday social and messaging apps, and they reach Class Hub
  from a link a classmate sent, signing in with their Google account. Their job: see who is here, look at and add
  photos, read and reply to class news, and talk in one shared room.
- **Admins:** one or two classmates who deploy the site, invite the others, moderate, change its name and look, and
  keep backups. Comfortable following a README and a terminal, not necessarily developers.
- **Self-hosters:** other classes who clone the public repository, rebrand it and run their own copy.

## Product Purpose

A small, private home for one class: a photo wall, a discussion board, one live chat room, a private member directory
and an admin page, free to run inside Cloudflare's free allowances and maintainable without a server administrator.
Success: members come back around a reunion and between them, add photos and posts without help, and the class's
memories outlive any one social platform.

## Positioning

Owned by the class, not a platform: invite-only behind the classmates' own Google sign-in, no public profiles, no
feed algorithm, no ads, no recurring bill, and the whole record (members, posts, photos, chat) is exportable and
restorable without Cloudflare.

## Operating Context

- Use comes in bursts around a reunion (plans and who's coming before, photos from phones during, sharing memories
  after) and as an ongoing keepsake in between: an album and directory people return to now and then.
- Mostly on phones, often one-handed and on mobile data; desktop for admins and for browsing the photo wall.
- Default language Vietnamese, with English; times in the viewer's time zone.
- Members already live in group chats and social apps; Class Hub is where things are kept, not another feed to
  check.

## Capabilities and Constraints

- Screens: home, memories (photo wall, albums, year filters, upload), discussions (threads, one-level comments),
  live chat (one room), members directory and profiles with per-field contact visibility, my profile (export,
  deletion request), admin, plus the setup-locked and no-access screens (`docs/spec/app/03-screens-roles.md`).
- Rebranding without code: site name, class years, description, welcome message, banner, logo, favicon, theme
  preset, light/dark/system mode, accent colour (contrast-checked), card density, default language, feature toggles
  (`docs/spec/app/10-themes-i18n.md`).
- Three shipped theme presets: `minimal` (clean, neutral), `yearbook` (nostalgic: uniform pale blue and ballpoint ink, the default),
  `night` (dark by design). New themes set only contract tokens; pages are never forked for styling.
- Photos are resized and re-encoded in the browser before upload; no video; no full-text search; no push
  notifications.
- No third-party requests from the page: fonts are system stacks or bundled files; no analytics, no CDNs.
- Free-tier budget: pages stay light (few D1 reads per view, 10 ms CPU per request).

## Brand Commitments

- The shipped product is neutral: each class supplies its own name, years, logo, banner and accent from `/admin`.
- The visual direction takes the owner's own class reunion site as its reference, not a copy: nostalgic in look,
  modern in use. The class is a wall of rows in ballpoint blue on uniform pale blue, with one red mark
  (`docs/design/01-DIRECTION.md`). The first real deployment is the owner's class; its identity is
  entered through `/admin`, never committed.
- Placeholder content is always synthetic.

## Evidence on Hand

- No real class content, photos, names or logos are in the repo, and none may be added (INV-6). Demo content comes
  from `npm run db:seed:demo`: 12 synthetic classmates at `@example.com`, generated gradient placeholder images.
- No testimonials, usage figures or user research exist yet; don't fabricate them.

## Product Principles

1. **Private by default.** Nothing about a member shows beyond what they chose to share, and a denied visitor learns
   nothing.
2. **A keepsake, not a feed.** Calm, findable, chronological; no streaks, counts to chase or engagement tricks.
3. **The class's own place.** Every class can make it look like theirs without touching code.
4. **Light enough to be free.** Every screen fits the free allowances and works on a mid-range phone on mobile data.
5. **Leaving is always possible.** Data export and restore are part of the product, not an afterthought.

## Accessibility & Inclusion

WCAG 2.2 AA in every theme and mode: full keyboard operation, visible focus, alt text, labelled fields, touch targets
of at least 44 px, `prefers-reduced-motion` and `forced-colors` respected; Vietnamese diacritics render correctly in
every font choice.
