// R-UI-02: Level B project configuration. Public defaults only; no secrets.
// Every service reads this through src/lib/config/ and never re-declares a default.
export const siteDefaults = {
  appName: 'Class Hub',
  name: 'Our Class',
  years: '20XX–20YY',
  locale: 'vi',
  // R-UI-11: the zone times show in until the viewer's browser has sent its own (the `tz` cookie).
  timeZone: 'Asia/Ho_Chi_Minh',
  theme: 'yearbook',
  mode: 'light',
  accent: null,
  nav: ['home', 'memories', 'discussions', 'chat', 'members'],
  profileFields: ['city', 'bio', 'contact_email', 'phone', 'messaging_url'],
  // R-AUTH-27: the public /join form stays off until an admin turns it on.
  features: { memories: true, discussions: true, chat: true, join: false },
  uploads: {
    maxImageBytes: 25_000_000,
    imageTypes: ['image/jpeg', 'image/webp'],
  },
  limits: { mediaWarnBytes: 8_000_000_000, mediaStopBytes: 9_000_000_000, photosPerDay: 25 },
  deletedMediaGraceDays: 7,
  chat: { retainDays: 365, maxMessages: 30_000 },
  // R-AUTH-29: pending join requests at most (1–50), and never more than the free seats.
  join: { maxPending: 20 },
  // R-AUTH-08: days an invite stays usable; null means it never expires.
  invite: { expiryDays: 30 },
  // R-PROF-06: hosts a `messaging_url` may point at (subdomains included); add to extend.
  messagingHosts: ['zalo.me', 'wa.me', 'm.me', 'messenger.com', 't.me', 'facebook.com', 'line.me'],
} as const;
