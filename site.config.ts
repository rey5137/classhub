// R-UI-02: Level B project configuration. Public defaults only; no secrets.
// Every service reads this through src/lib/config/ and never re-declares a default.
export const siteDefaults = {
  appName: 'Class Hub',
  name: 'Our Class',
  years: '20XX–20YY',
  locale: 'vi',
  theme: 'yearbook',
  mode: 'light',
  accent: null,
  nav: ['home', 'memories', 'discussions', 'chat', 'members'],
  profileFields: ['city', 'schoolYears', 'bio', 'email', 'phone', 'social'],
  features: { memories: true, discussions: true, chat: true },
  uploads: {
    maxImageBytes: 25_000_000,
    imageTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  limits: { mediaWarnBytes: 8_000_000_000, mediaStopBytes: 9_000_000_000, photosPerDay: 25 },
  chat: { retainDays: 365, maxMessages: 30_000 },
  messagingHosts: ['zalo.me', 'm.me', 'wa.me'],
} as const;
