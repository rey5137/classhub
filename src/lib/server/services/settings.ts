import {
  settingKeys,
  settingsPatchSchema,
  settingsShape,
  siteMediaKeys,
  siteSettingsSchema,
  type SettingKey,
  type SiteSettings,
} from '../../contracts/settings';
import { siteConfig } from '../../config';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import type { DatabaseHandle } from '../ports/database';
import {
  findLiveSiteMedia,
  readSettingRows,
  setupUnlockedIn,
  writeSettings,
  type SettingRows,
} from '../repositories/settings';
import { parse, type AdminFailure, type AdminResult } from './admin';

const forbidden: AdminFailure = { ok: false, code: 'forbidden' };

/**
 * R-UI-01/R-UI-02: what an admin has not set yet. Level B keys come from `siteConfig`
 * (never repeated here); the Level A-only keys start empty.
 */
export const defaultSettings: SiteSettings = {
  name: siteConfig.name,
  years: siteConfig.years,
  description: '',
  welcome: '',
  bannerMediaId: null,
  logoMediaId: null,
  faviconMediaId: null,
  theme: siteConfig.theme,
  mode: siteConfig.mode,
  accent: siteConfig.accent,
  density: 'comfortable',
  locale: siteConfig.locale,
  features: siteConfig.features,
};

function storedValue(rows: SettingRows, key: SettingKey): unknown {
  const raw = rows.get(key);
  if (raw === undefined) return undefined;
  try {
    const parsed = settingsShape[key].safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Level B overlaid by every stored row that still parses. A stored accent the stored
 * theme no longer accepts is dropped rather than rendered (R-UI-04).
 */
export function effectiveSettings(rows: SettingRows): SiteSettings {
  const merged: Record<string, unknown> = { ...defaultSettings };
  for (const key of settingKeys) {
    const value = storedValue(rows, key);
    if (value !== undefined) merged[key] = value;
  }
  const checked = siteSettingsSchema.safeParse(merged);
  if (checked.success) return checked.data;
  const withoutAccent = siteSettingsSchema.safeParse({ ...merged, accent: null });
  return withoutAccent.success ? withoutAccent.data : defaultSettings;
}

export interface SiteState {
  settings: SiteSettings;
  setupUnlocked: boolean;
}

/** The pipeline's one `site_settings` read per request (setup lock, appearance, features). */
export async function loadSiteState(db: DatabaseHandle): Promise<SiteState> {
  const rows = await readSettingRows(db);
  return { settings: effectiveSettings(rows), setupUnlocked: setupUnlockedIn(rows) };
}

/** `GET /api/v1/admin/settings`: the effective settings this request already read. */
export function getSettings(member: Member, current: SiteSettings): AdminResult<SiteSettings> {
  if (!can(member, 'settings.edit')) return forbidden;
  return { ok: true, status: 200, body: current };
}

/**
 * `PATCH /api/v1/admin/settings` and the `/admin` form (R-UI-01, R-UI-04): only the
 * keys sent are written; the merged result is validated as a whole, so a theme change
 * re-checks the stored accent against the new theme.
 */
export async function updateSettings(
  context: AppContext,
  member: Member,
  current: SiteSettings,
  input: unknown,
  now = Date.now(),
): Promise<AdminResult<SiteSettings>> {
  if (!can(member, 'settings.edit')) return forbidden;
  const patch = parse(settingsPatchSchema, input);
  if (!patch.ok) return patch;
  const { features, ...rest } = patch.data;
  const changes: Partial<SiteSettings> = {
    ...rest,
    ...(features ? { features: { ...current.features, ...features } } : {}),
  };
  const merged = siteSettingsSchema.safeParse({ ...current, ...changes });
  if (!merged.success) {
    const fields: Record<string, string> = {};
    // The contrast refusal keeps its sentence so the field names the measured ratio.
    for (const issue of merged.error.issues) {
      fields[issue.path.join('.') || '_'] ??= issue.code === 'custom' ? issue.message : issue.code;
    }
    return { ok: false, code: 'validation', fields };
  }

  const mediaIds = siteMediaKeys.flatMap((key) => {
    const id = changes[key];
    return typeof id === 'string' ? [id] : [];
  });
  const deadMedia = async () => {
    const live = await findLiveSiteMedia(context.database, mediaIds);
    const fields: Record<string, string> = {};
    for (const key of siteMediaKeys) {
      const id = changes[key];
      if (typeof id === 'string' && !live.has(id)) fields[key] = 'not_found';
    }
    return Object.keys(fields).length > 0 ? fields : null;
  };
  const dead = await deadMedia();
  if (dead) return { ok: false, code: 'validation', fields: dead };

  // A replaced or removed picture goes, unless a setting still shows it: this request's
  // own (`kept`) or one written since the snapshot (re-checked in the write's batch).
  const kept = new Set(siteMediaKeys.map((key) => merged.data[key]));
  const retire = siteMediaKeys.flatMap((key) => {
    const previous = current[key];
    return key in changes && previous && !kept.has(previous) ? [previous] : [];
  });
  const entries = Object.entries(changes) as [SettingKey, unknown][];
  if (entries.length > 0) {
    const written = await writeSettings(context.database, entries, member.id, now, {
      retire: [...new Set(retire)],
      requireLive: mediaIds,
      mergePatch: features ? { features } : {},
    });
    // A picture deleted between the check above and the write: nothing was written.
    if (!written) {
      return { ok: false, code: 'validation', fields: (await deadMedia()) ?? { _: 'conflict' } };
    }
  }
  // The reply shows what is stored, so a concurrent toggle never reads back stale.
  const stored =
    entries.length > 0
      ? effectiveSettings(await readSettingRows(context.database.db))
      : merged.data;
  return { ok: true, status: 200, body: stored };
}
