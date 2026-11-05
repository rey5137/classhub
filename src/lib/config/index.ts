import { z } from 'zod';
import { siteDefaults } from '../../../site.config';
import { contrastRatio, formatRatio } from '../themes/contrast';
import { themeIds, themes } from '../themes/registry';
import { themeTokens, type ThemeId, type ThemeMode } from '../themes/theme-tokens';

const hexColour = z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a #rrggbb colour');

// R-UI-04: only plain text reaches a page; CSS, markup and scripts are refused.
const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[{}<>]|url\(|expression\(/i.test(value), 'CSS and markup are not allowed');

const siteConfigSchema = z
  .object({
    appName: safeText(60),
    name: safeText(80),
    years: safeText(40),
    locale: z.enum(['vi', 'en']),
    theme: z.enum(themeIds as [ThemeId, ...ThemeId[]], { message: 'Unknown theme id' }),
    mode: z.enum(['light', 'dark', 'system']),
    accent: z
      .object({ light: hexColour.optional(), dark: hexColour.optional() })
      .strict()
      .nullable(),
    nav: z
      .array(z.enum(['home', 'memories', 'discussions', 'chat', 'members']))
      .min(1)
      .max(5)
      .refine((items) => new Set(items).size === items.length, 'nav items must be unique'),
    profileFields: z
      .array(z.enum(['city', 'schoolYears', 'bio', 'email', 'phone', 'social']))
      .max(16),
    features: z
      .object({
        memories: z.boolean(),
        discussions: z.boolean(),
        chat: z.boolean(),
      })
      .strict(),
    uploads: z
      .object({
        maxImageBytes: z.number().int().positive().max(1_000_000_000),
        imageTypes: z.array(z.enum(['image/jpeg', 'image/png', 'image/webp'])).min(1),
      })
      .strict(),
    limits: z
      .object({
        mediaWarnBytes: z.number().int().positive(),
        mediaStopBytes: z.number().int().positive(),
        photosPerDay: z.number().int().positive(),
      })
      .strict(),
    chat: z
      .object({
        retainDays: z.number().int().positive().max(3650),
        maxMessages: z.number().int().positive(),
      })
      .strict(),
    messagingHosts: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    // R-UI-04: the accent is set per mode; each key must clear WCAG AA against its own
    // mode's surface, and a mode the theme does not ship is refused.
    if (value.accent === null) return;
    const shipped: ThemeMode[] = themes[value.theme].modes;
    for (const mode of ['light', 'dark'] as const) {
      const colour = value.accent[mode];
      if (colour === undefined) continue;
      const surface = shipped.includes(mode) ? themeTokens[value.theme][mode]?.surface : undefined;
      if (!surface) {
        ctx.addIssue({
          code: 'custom',
          path: ['accent', mode],
          message: `Theme ${value.theme} has no ${mode} mode, so a ${mode} accent is refused`,
        });
        continue;
      }
      const ratio = contrastRatio(colour, surface);
      if (ratio < 4.5) {
        ctx.addIssue({
          code: 'custom',
          path: ['accent', mode],
          message: `Accent ${colour} measures ${formatRatio(ratio)} against the ${value.theme} ${mode} surface; 4.5:1 is required`,
        });
      }
    }
  });

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
