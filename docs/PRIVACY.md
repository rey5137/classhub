# Privacy

Class Hub is a private site for one class. This page says what it stores about members, who can see it, where it
lives, and how long it stays. It describes the software as shipped; the admins who run a site may change its settings
(for example how long chat is kept), and they are the ones responsible for the data on it.

## Who runs the site

Each Class Hub site is run by its own admins on their own Cloudflare account. There is no central Class Hub service:
the project's authors never see a site's data.

The site uses two outside services:

- **Cloudflare** hosts the app (Workers), its database (D1) and its photos (R2), and checks sign-in (Cloudflare
  Access).
- **Google** (or Cloudflare's one-time email PIN) proves who you are when you sign in. The site receives only your
  verified email address from it.

The site loads no third-party analytics, ads, embeds, fonts or scripts.

## Who can get in

Only people an admin has invited can open the site. Everyone else, including a signed-in Google account that isn't on
the list, sees the same "no access" page, and no member data is sent to them. A suspended member is treated the same
way.

## What is stored about you

| Data | Who can see it |
|---|---|
| Your login email | You, and admins on the invite screen. Never shown to other members, even if it matches your contact email. |
| Display name | Every member. |
| Nickname (`preferred_name`), short bio, profile picture | Every member, by default. You can change this. |
| Contact email, phone, messaging link (Zalo, WhatsApp, Messenger…), city | Only you, by default. You choose who sees each one. |
| Photos, captions, albums you upload | Every member. |
| Posts and comments | Every member. |
| Chat messages | Every member. |

For each optional profile field you choose one of three levels:

- **Only me**: nobody else sees it, admins included.
- **Admins**: you and the site's admins.
- **Members**: every active member.

There is no bulk export of members' contact details in the app.

**Photos.** Your browser re-encodes every photo before it is uploaded, which removes its EXIF data, including the GPS
location. The original file never leaves your device.

**Logs.** Server logs record a request id, the page, the result and a scrambled (salted hash) form of your member id.
They never contain emails, contact details, message text, captions or sign-in tokens.

**Your device.** The site stores your chosen language (a `classhub.locale` cookie and browser storage) and, for chat,
the last message you read (browser storage). Cloudflare Access sets its own sign-in cookie. Nothing is used for
tracking.

## Push notifications

Notifications are off on every device until you turn them on from `/notifications`.

- **What is stored:** when you turn notifications on for a device, the site stores that browser's Web Push endpoint URL,
  its encryption keys (`p256dh` and `auth`), your chosen language, and a short device label such as "Chrome on Android"
  (never your raw browser user-agent string), along with which notification kinds you want (`chat`, `thread`, `reply`,
  and for admins `join`) and any temporary mute setting. Subscriptions stay until you remove them or your account is
  deleted; restoring a backup onto a new site empties all device subscriptions so no push goes to an old registration.
- **What push services see:** the Worker sends Web Push directly to your browser vendor's push service (Google, Apple,
  Mozilla or Microsoft) with no third-party relay or SDK. The push service sees your device's push endpoint URL, when a
  push is sent, and its encrypted size. The notification title and text are encrypted end-to-end (`aes128gcm`) to your
  device, so the push service cannot read them.
- **Lock screen previews:** what appears on a locked phone or computer screen is controlled by your device's own
  notification preview setting. A message deleted after a push was sent cannot be recalled from a device that already
  showed it.
- **How to turn it off:** open `/notifications` and press *Turn off for this device* (or *Remove* next to any listed
  device) to delete the subscription at once, or choose a temporary mute.

## Join requests

Admins can turn on a public "ask to join" page at `/join` (off by default). When it is on, anyone with the link can
send a request with a name, an email address and an optional short note. The site stores those three things, the time,
and a scrambled (salted hash) form of the sender's IP address, used only to limit how many requests one connection can
send; the IP address itself is never stored or logged. Only admins see requests, on the admin page. No email is sent to the requester automatically.

A request is deleted when an admin approves it (it becomes an ordinary invite) or rejects it, and in any case after 30
days. The page uses Cloudflare Turnstile, a check run by Cloudflare that tells people from bots, and only on `/join` and
only while the page is on; no other page loads anything from a third party.

One small thing the page can give away: while the list of waiting requests is one short of full, someone who sends
a request and then reloads `/join` can tell whether that address was new (the page then says requests are closed).
It needs a nearly full list and allows only three tries per connection per hour, so the admins accepted it.

## Email

The site sends one kind of email: the invite, when an admin presses *Send invite email* for someone already invited.
It goes from the admin's own Gmail account and says how to sign in. Nothing else is emailed.

The site also has a public summary of this page, in Vietnamese, at `/privacy`; it is the link Google's sign-in screen
shows.

## How long data is kept

- **Posts and comments** stay until their author or an admin deletes them.
- **Chat messages** are kept for 365 days and at most 30,000 messages by default (admins can change both). Older
  messages are first saved to an encrypted archive held by the admins, checked, and only then removed from the site.
  Archives aren't shown in the app. The archives are encrypted and held only by the admins. When a deletion is
  completed, the messages the member chose to delete are left out of later archives; messages they chose to keep stay
  in them under *Former member*, with no contact details. An archive made before your deletion still holds your
  messages until that archive file is deleted. There is currently no fixed time after which the admins delete chat
  archives.
- **Deleted photos** disappear from the site at once. Their files are kept for a grace period (7 days by default) in
  case the deletion was a mistake, then purged.

## Your choices

From `/profile` you can:

- **Change who sees each field** at any time. The change applies at once.
- **Download your data**: a file with your own profile, contact details, posts, comments, chat messages and photo
  details, with links to your photos. It contains no other member's contact details.
- **Clear your profile**: empties every optional field and removes your profile picture. Both leave the site at once;
  the picture's files are purged after the grace period.
- **Ask for your account to be deleted.** From the moment you ask, your contact details are hidden from everyone but
  you. When an admin completes the request:
  - your account is closed and your profile and contact details are cleared;
  - your name is shown as *Former member*;
  - your login email is removed from the site's data, so you could be invited again later;
  - your posts, comments, photos and chat messages are either kept under *Former member* or deleted, as you chose
    when you asked.

## Backups

The admins keep backups of the site so it can be restored if something goes wrong. **Backups contain everything on
the site, including members' contact details.** They are:

- **encrypted** as they are made, for a key only the admins hold;
- stored by the admins **outside** the live site;
- kept on a schedule: the last 12 weekly and 12 monthly copies. Older copies are deleted.

A deletion removes your data from the live site at once. It isn't removed from backups made before it: it disappears
from them as those copies age out under the schedule above (at most about a year).

Restoring an older backup would bring a deleted member's data back, because the backup was made before the deletion.
So after any restore the admins check every deletion completed since that backup was made. If the restored data still
holds the request, they complete it again. If the backup was made before the request, they suspend the account at once
and ask the person to request deletion again.

## Questions

Ask the site's admins: they run the site and can answer for its data.
