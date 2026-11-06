import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { siteMediaKeys } from '../../contracts/settings';
import { invites, media, schemaMeta, siteSettings, users } from '../db/schema';
import type { Database, DatabaseHandle } from '../ports/database';
import { auditInsertWhere } from './audit';

export const SETUP_STATE_KEY = 'setup_state';

/** R-MEM-11: one request claims the hourly slot, including across Worker isolates. */
export async function claimHousekeeping(db: DatabaseHandle, now: number): Promise<boolean> {
  const rows = await db
    .update(schemaMeta)
    .set({ value: String(now) })
    .where(
      and(
        eq(schemaMeta.key, 'housekeeping_last_run_at'),
        sql`cast(${schemaMeta.value} as integer) < ${now - 3_600_000}`,
      ),
    )
    .returning({ key: schemaMeta.key });
  return rows.length === 1;
}

export type SettingRows = ReadonlyMap<string, string>;

/** The request's one settings read (R-UI-01): every `site_settings` row, setup state included. */
export async function readSettingRows(db: DatabaseHandle): Promise<SettingRows> {
  const rows = await db
    .select({ key: siteSettings.key, value: siteSettings.valueJson })
    .from(siteSettings);
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** R-AUTH-12: anything but a stored `"unlocked"` (no row, bad JSON, `"locked"`) is locked. */
export function setupUnlockedIn(rows: SettingRows): boolean {
  const raw = rows.get(SETUP_STATE_KEY);
  if (raw === undefined) return false;
  try {
    return JSON.parse(raw) === 'unlocked';
  } catch {
    return false;
  }
}

/**
 * R-UI-01: one upsert per changed key and one `settings.update` audit row (no values),
 * atomically, with the banner, logo or favicon pictures the change leaves unused
 * soft-deleted in the same batch (R-MEM-20 purges the objects). Every statement holds
 * only while each picture in `requireLive` is still a live `site` row, so a picture
 * deleted since the caller checked is never named; false when nothing was written.
 */
export async function writeSettings(
  database: Database,
  entries: [key: string, value: unknown][],
  actorId: string,
  now: number,
  options: { retire?: string[]; requireLive?: string[] } = {},
): Promise<boolean> {
  const { retire = [], requireLive = [] } = options;
  const live = and(
    sql`1 = 1`,
    ...requireLive.map(
      (id) =>
        sql`exists (select 1 from ${media} where ${and(eq(media.id, id), eq(media.mediaType, 'site'), isNull(media.deletedAt))})`,
    ),
  )!;
  const upserts = entries.map(([key, value]) => {
    const valueJson = JSON.stringify(value);
    return database.db
      .insert(siteSettings)
      .select(sql`select ${key}, ${valueJson}, ${actorId}, ${now} where ${live}`)
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { valueJson, updatedBy: actorId, updatedAt: now },
      });
  });
  const [audit] = await database.batch([
    auditInsertWhere(
      database.db,
      {
        actorId,
        action: 'settings.update',
        entityType: 'settings',
        entityId: 'site',
        createdAt: now,
      },
      live,
    ),
    ...upserts,
    ...(retire.length > 0
      ? [
          database.db
            .update(media)
            .set({ deletedAt: now })
            .where(
              and(
                inArray(media.id, retire),
                eq(media.mediaType, 'site'),
                isNull(media.deletedAt),
                live,
              ),
            ),
        ]
      : []),
  ]);
  return (audit?.changes ?? 0) > 0;
}

/**
 * R-UI-01: soft-deletes a live site picture unless a setting still names it, checked in
 * the same statement. With `writeSettings` requiring its pictures live in its own batch,
 * neither order of a delete and a settings write leaves a setting naming a deleted row.
 */
export async function softDeleteUnusedSiteMedia(
  database: Database,
  id: string,
  now: number,
): Promise<boolean> {
  const referenced = database.db
    .select({ key: siteSettings.key })
    .from(siteSettings)
    .where(
      and(
        inArray(siteSettings.key, [...siteMediaKeys]),
        eq(siteSettings.valueJson, JSON.stringify(id)),
      ),
    );
  const rows = await database.db
    .update(media)
    .set({ deletedAt: now })
    .where(
      and(
        eq(media.id, id),
        eq(media.mediaType, 'site'),
        isNull(media.deletedAt),
        notExists(referenced),
      ),
    )
    .returning({ id: media.id });
  return rows.length === 1;
}

/** The ids among `ids` that are live `site` media (R-UI-01: banner, logo, favicon). */
export async function findLiveSiteMedia(database: Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await database.db
    .select({ id: media.id })
    .from(media)
    .where(and(inArray(media.id, ids), eq(media.mediaType, 'site'), isNull(media.deletedAt)));
  return new Set(rows.map((row) => row.id));
}

/**
 * R-AUTH-12: the bootstrap admin is the admin whose own invite names them as the
 * inviter. `setup` creates that invite before anyone else exists, so no later
 * invite can be self-issued (`invites.invited_by` is always an existing member).
 */
export async function isBootstrapAdmin(db: DatabaseHandle, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(invites, eq(invites.email, users.authEmail))
    .where(
      and(eq(users.id, userId), eq(users.role, 'admin'), sql`${invites.invitedBy} = ${users.id}`),
    )
    .limit(1);
  return rows.length > 0;
}
