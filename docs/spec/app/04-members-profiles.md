# 04 — Members and profiles

**Covers:** Profile fields, per-field contact visibility, the directory, contact link safety, own-data export and deletion requests.
**Read when:** touching a profile field, the directory, any response that carries member data, or an export.
**Owns:** `R-PROF-*`, `AC-PROF-*`.
**Index:** `docs/spec/SPEC.md` (product boundary §1, locked decisions D1–D10, routing). Section numbers are global: `§4.n` is in this file.

---

## 4.1 Fields

- **R-PROF-01** **Required:** `display_name` (1–80 characters after trimming, Unicode, no control characters) and
  `auth_email` (the verified identity email, lower-cased; set by sign-in, never editable from the UI).
- **R-PROF-02** **Optional fields and their default visibility:**

| Field | Example | Default visibility | Limit |
|---|---|---|---|
| `preferred_name` | school nickname | `members` | 80 chars |
| `contact_email` | address for contact, may differ from login | `private` (opt-in) | RFC 5322 address, 254 chars |
| `phone` | E.164 where it parses, else as typed | `private` | 32 chars |
| `messaging_url` | Zalo, WhatsApp, Messenger link | `private` | 300 chars, allow-listed (R-PROF-06) |
| `city` | current city/region | `private` (opt-in) | 80 chars |
| `bio` | a few sentences, plain text | `members` | 500 chars |
| `avatar_media_id` | uploaded picture (§7.4) | `members` | — |

## 4.2 Visibility

- **R-PROF-03** Each optional field has its own visibility, one of `private` (owner only), `admins` (owner and
  admins), `members` (every active member). It is stored in `profile_contacts.visibility_json` as a map of field to
  value, validated by Zod; an unknown or missing key means `private`.
- **R-PROF-04** **One projection function** (`projectProfile(viewer, owner)`) builds every member payload that leaves
  the server: directory rows, profile pages, `/api/v1/members*`, chat sender info, post author info. It drops each
  field the viewer may not see, before serialization. No route builds member JSON by itself (INV-5).
- **R-PROF-05** `auth_email` is returned only to its owner (`/api/v1/me`) and to admins on the invite screen; it is
  never in the directory, another member's profile, chat, posts or a member export, even when it equals
  `contact_email` (the contact email is shown only through its own visibility).
- **R-PROF-06** **Contact links are normalized on save:** a phone becomes a `tel:` link, an email a `mailto:` link,
  and `messaging_url` must be `https:` on an allow-listed host (`zalo.me`, `wa.me`, `m.me`, `messenger.com`,
  `t.me`, `facebook.com`, `line.me`; extensible in `site.config.ts`). `javascript:`, `data:`, other schemes and
  credentials in URLs are rejected with a field error.
- **R-PROF-07** Profile and contact JSON, and every private HTML page (R-AUTH-20), is sent with `Cache-Control: private, no-store`.

## 4.3 Directory

- **R-PROF-08** `/members` lists `active` members only, ordered by `display_name`, 50 per page with a keyset cursor,
  searchable by `display_name` and `preferred_name` (case- and accent-insensitive prefix match on any word of the normalized
  columns `display_name_norm` and `preferred_name_norm`). Members never get a bulk contact export from the UI.

## 4.4 Own data, deletion and retention

- **R-PROF-09** **Own export:** `/profile` offers *Download my data*: a JSON file with the member's own profile,
  contacts, posts, comments, chat messages and media metadata, plus links to their own photos. It contains no other
  member's contact data.
- **R-PROF-10** **Clear my profile:** the member can empty every optional field and remove the avatar at once.
- **R-PROF-11** **Deletion request:** the member can ask for account deletion from `/profile`; it is recorded and shown
  to admins, and **from that moment** `projectProfile` hides all of the member's contact fields (R-PROF-13). An admin completes it: the member is suspended, the profile and contacts are cleared, `display_name`
  becomes the localized *Former member*, `auth_email` is replaced by a tombstone (`deleted+<id>@invalid`, lower-case so it satisfies the `auth_email` `CHECK`, so the person can be invited again, R-AUTH-08); the matching `invites.email` is rewritten to the same tombstone and the invite set `revoked`, so the real email no longer remains in the live data (R-DB-13), and the member's posts, comments, photos and chat messages are either kept
  under that name or deleted, as the member chose in the request. Authorship rows keep their foreign keys (R-DB-04).
- **R-PROF-12** `/profile` and `docs/PRIVACY.md` state plainly that admin backups (§13) contain contact data, are kept
  encrypted for the documented retention period (R-BAK-11), and that a deletion removes data from the live site at
  once and from backups as they age out.
- **R-PROF-13** **Non-active owners.** When the profile owner's status is not `active` (suspended or invited),
  `/members/[id]` and every other payload built by `projectProfile` carry only the display name (the *Former member*
  name after a completed deletion): no avatar, bio, contacts or `preferred_name`, whatever the field visibility. A
  pending deletion request hides contact fields at once for every viewer except the owner.

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-PROF-01 | For every field × visibility × viewer (owner, member, admin), the payload has the field exactly when allowed | R-PROF-03, 04 | unit table test |
| AC-PROF-02 | `auth_email` appears in no payload except `/me` for its owner and the admin invite list | R-PROF-05 | integration: grep of every API response for the fixture emails |
| AC-PROF-03 | A new member's phone, contact email, messaging URL and city are private until changed | R-PROF-02 | integration |
| AC-PROF-04 | `javascript:`, `data:` and non-allow-listed messaging URLs are refused; valid phone/email become `tel:`/`mailto:` | R-PROF-06 | unit |
| AC-PROF-05 | Own export holds only the requester's data; another member's contacts are absent | R-PROF-09 | integration |
| AC-PROF-06 | A completed deletion leaves no contact data, renders *Former member*, and keeps or deletes content as requested | R-PROF-11 | integration |
| AC-PROF-07 | Directory paging and search work over 50 synthetic members with accents | R-PROF-08 | integration + e2e |
| AC-PROF-08 | A suspended owner's `/members/[id]` and author links show only the display name; a pending deletion request hides contacts at once; after completion `auth_email` and the matching `invites.email` are the tombstone (invite `revoked`) and the same email can be invited again | R-PROF-13, 11 | integration |
