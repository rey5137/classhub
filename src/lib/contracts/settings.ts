import { z } from 'zod';
import {
  accentSchema,
  featuresSchema,
  localeSchema,
  modeSchema,
  refineAccent,
  safeText,
  themeIdSchema,
} from '../config';

// R-UI-01/R-UI-04: Level A, the admin's site settings. Every validator Level B
// (`site.config.ts`) also has is the same one, imported from `$lib/config`.

/** A `media_type = "site"` row (§7), or none. The service checks it is live. */
const siteMediaId = z.uuid().nullable();

export const densities = ['comfortable', 'compact'] as const;

/** One schema per stored `site_settings` row (a row that no longer parses is ignored). */
export const settingsShape = {
  name: safeText(80),
  years: safeText(40),
  description: z.literal('').or(safeText(300)),
  // Markdown, rendered by the sanitizing renderer (R-BRD-03); raw HTML is refused outright.
  welcome: z
    .string()
    .max(2000)
    .refine((value) => !/<[a-z!/?]/i.test(value), 'HTML is not allowed'),
  bannerMediaId: siteMediaId,
  logoMediaId: siteMediaId,
  faviconMediaId: siteMediaId,
  theme: themeIdSchema,
  mode: modeSchema,
  accent: accentSchema,
  density: z.enum(densities),
  locale: localeSchema,
  features: featuresSchema,
};

export type SettingKey = keyof typeof settingsShape;
export const settingKeys = Object.keys(settingsShape) as SettingKey[];
/** The row holding the feature toggles (R-NAV-02), merged key by key on write. */
export const FEATURES_KEY = 'features' satisfies SettingKey;

/** The effective settings, `GET /api/v1/admin/settings`; the accent is checked against the theme. */
export const siteSettingsSchema = z
  .object(settingsShape)
  .strict()
  .superRefine((value, ctx) => refineAccent(value.theme, value.accent, ctx));
export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export type Features = SiteSettings['features'];
export type Feature = keyof Features;

/** `PATCH /api/v1/admin/settings`: only the keys sent change; feature flags merge one by one. */
export const settingsPatchSchema = z
  .object({ ...settingsShape, features: featuresSchema.partial().strict() })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const siteMediaKeys = ['bannerMediaId', 'logoMediaId', 'faviconMediaId'] as const;
