import { z } from 'zod';
import { siteDefaults } from '../../../site.config';
import { isTimeZone } from '../shared/time';
import { contrastRatio, formatRatio, parseHexColor } from '../themes/contrast';
import { themeIds, themes } from '../themes/registry';
import { themeTokens, type ThemeId, type ThemeMode } from '../themes/theme-tokens';

// Level B (this file) and Level A (`contracts/settings.ts`, R-UI-01) share these validators.
export const hexColour = z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a #rrggbb colour');

// R-UI-04: only plain text reaches a page; CSS, markup and scripts are refused.
export const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[{}<>]|url\(|expression\(/i.test(value), 'CSS and markup are not allowed');

export const localeSchema = z.enum(['vi', 'en']);
export const themeIdSchema = z.enum(themeIds as [ThemeId, ...ThemeId[]], {
  message: 'Unknown theme id',
});
export const modeSchema = z.enum(['light', 'dark', 'system']);
export const accentSchema = z
  .object({ light: hexColour.optional(), dark: hexColour.optional() })
  .strict()
  .nullable();
export const featuresSchema = z
  .object({
    memories: z.boolean(),
    discussions: z.boolean(),
    chat: z.boolean(),
  })
  .strict();

/**
 * R-UI-04: the accent is set per mode; each key must clear WCAG AA against its own
 * mode's surface, and a mode the theme does not ship is refused.
 */
export function refineAccent(
  theme: ThemeId,
  accent: z.infer<typeof accentSchema> | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!accent) return;
  const shipped: ThemeMode[] = themes[theme].modes;
  for (const mode of ['light', 'dark'] as const) {
    const colour = accent[mode];
    // A malformed colour already has its format issue; the refinement still runs on it.
    if (colour === undefined || !parseHexColor(colour)) continue;
    const surface = shipped.includes(mode) ? themeTokens[theme][mode]?.surface : undefined;
    if (!surface) {
      ctx.addIssue({
        code: 'custom',
        path: ['accent', mode],
        message: `Theme ${theme} has no ${mode} mode, so a ${mode} accent is refused`,
      });
      continue;
    }
    const ratio = contrastRatio(colour, surface);
    if (ratio < 4.5) {
      ctx.addIssue({
        code: 'custom',
        path: ['accent', mode],
        message: `Accent ${colour} measures ${formatRatio(ratio)} against the ${theme} ${mode} surface; 4.5:1 is required`,
      });
    }
  }
}

// R-MEM-06: uploads stay within the configured per-image ceiling.
const MAX_IMAGE_BYTES = 25_000_000;

const siteConfigSchema = z
  .object({
    appName: safeText(60),
    name: safeText(80),
    years: safeText(40),
    locale: localeSchema,
    timeZone: z.string().refine(isTimeZone, 'Expected an IANA time zone'),
    theme: themeIdSchema,
    mode: modeSchema,
    accent: accentSchema,
    nav: z
      .array(z.enum(['home', 'memories', 'discussions', 'chat', 'members']))
      .min(1)
      .max(5)
      .refine((items) => new Set(items).size === items.length, 'nav items must be unique'),
    profileFields: z
      .array(z.enum(['city', 'bio', 'contact_email', 'phone', 'messaging_url']))
      .max(16),
    features: featuresSchema,
    uploads: z
      .object({
        maxImageBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
        imageTypes: z.array(z.enum(['image/jpeg', 'image/webp'])).min(1),
      })
      .strict(),
    limits: z
      .object({
        mediaWarnBytes: z.number().int().positive(),
        mediaStopBytes: z.number().int().positive(),
        photosPerDay: z.number().int().positive(),
      })
      .strict(),
    deletedMediaGraceDays: z.number().int().min(1).max(90),
    chat: z
      .object({
        retainDays: z.number().int().positive().max(3650),
        maxMessages: z.number().int().positive(),
      })
      .strict(),
    invite: z
      .object({
        expiryDays: z.number().int().positive().max(3650).nullable(),
      })
      .strict(),
    messagingHosts: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).max(20),
  })
  .strict()
  .superRefine((value, ctx) => refineAccent(value.theme, value.accent, ctx));

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export class SiteConfigError extends Error {
  override name = 'SiteConfigError';
}

export function validateSiteConfig(input: unknown): SiteConfig {
  const result = siteConfigSchema.safeParse(input);
  if (!result.success) {
    throw new SiteConfigError(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

export const siteConfig: SiteConfig = validateSiteConfig(siteDefaults);
