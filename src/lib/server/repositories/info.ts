import { and, asc, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { INFO_PAGES_LIMIT, type InfoCreate, type InfoPatch } from '../../contracts/info';
import { infoPages } from '../db/schema';
import { uuidv7 } from '../ids';
import type { Database } from '../ports/database';
import { auditInsertWhere } from './audit';

export type InfoPageRow = typeof infoPages.$inferSelect;

const summary = {
  id: infoPages.id,
  slug: infoPages.slug,
  title: infoPages.title,
  isPinned: infoPages.isPinned,
  sortOrder: infoPages.sortOrder,
  updatedAt: infoPages.updatedAt,
};

const order = [
  desc(infoPages.isPinned),
  asc(infoPages.sortOrder),
  asc(infoPages.title),
  asc(infoPages.id),
];

export interface InfoCursor {
  isPinned: boolean;
  sortOrder: number;
  title: string;
  id: string;
}

const afterTuple = (after: InfoCursor) =>
  sql`(${infoPages.sortOrder}, ${infoPages.title}, ${infoPages.id}) > (${after.sortOrder}, ${after.title}, ${after.id})`;

async function pageInfoRows<T extends Record<string, unknown>>(
  database: Database,
  selection: T,
  options: {
    after?: InfoCursor | null;
    limit?: number;
    pinnedOnly?: boolean;
    excludeSlug?: string;
  } = {},
) {
  const limit = options.limit ?? INFO_PAGES_LIMIT;
  const target = limit + 1;
  const base: (SQL | undefined)[] = [
    options.pinnedOnly ? eq(infoPages.isPinned, true) : undefined,
    options.excludeSlug ? ne(infoPages.slug, options.excludeSlug) : undefined,
  ];
  const { after } = options;
  if (!after) {
    const rows = await database.db
      .select(selection as never)
      .from(infoPages)
      .where(and(...base))
      .orderBy(...order)
      .limit(target);
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  }
  if (options.pinnedOnly && !after.isPinned) {
    return { rows: [], more: false };
  }
  const first = await database.db
    .select(selection as never)
    .from(infoPages)
    .where(and(...base, eq(infoPages.isPinned, after.isPinned), afterTuple(after)))
    .orderBy(...order)
    .limit(target);
  if (first.length >= target || !after.isPinned || options.pinnedOnly) {
    return { rows: first.slice(0, limit), more: first.length > limit };
  }
  const rest = await database.db
    .select(selection as never)
    .from(infoPages)
    .where(and(...base, eq(infoPages.isPinned, false)))
    .orderBy(...order)
    .limit(target - first.length);
  const combined = [...first, ...rest];
  return { rows: combined.slice(0, limit), more: combined.length > limit };
}

/** R-BRD-01/02: pinned first, then the admin's order, then title, then id. */
export async function listInfoPages(
  database: Database,
  options: {
    after?: InfoCursor | null;
    limit?: number;
    pinnedOnly?: boolean;
    excludeSlug?: string;
  } = {},
) {
  return pageInfoRows(database, summary, options);
}

/** R-BRD-01: Home's pinned info links (excluding `reunion`, which has its own card). */
export async function listPinnedInfoPages(
  database: Database,
  options: { after?: InfoCursor | null; limit?: number } = {},
) {
  return pageInfoRows(database, summary, {
    ...options,
    pinnedOnly: true,
    excludeSlug: 'reunion',
  });
}

/** The same list with each page's Markdown, for the `/admin` editor. */
export async function listInfoPagesWithBody(
  database: Database,
  options: { after?: InfoCursor | null; limit?: number } = {},
) {
  return pageInfoRows(database, { ...summary, bodyMd: infoPages.bodyMd }, options);
}

export async function findInfoPage(database: Database, where: { id: string } | { slug: string }) {
  const condition = 'id' in where ? eq(infoPages.id, where.id) : eq(infoPages.slug, where.slug);
  return (await database.db.select().from(infoPages).where(condition).limit(1))[0];
}

const exists = (condition: SQL | undefined) =>
  sql`exists (select 1 from ${infoPages} where ${condition})`;

/** Inserts the page with its `info.create` audit row; undefined when the slug is taken (R-DB-05). */
export async function insertInfoPage(
  database: Database,
  input: InfoCreate,
  actorId: string,
  now: number,
): Promise<InfoPageRow | undefined> {
  const id = uuidv7(now);
  const { body, ...fields } = input;
  const [inserted] = await database.batch([
    database.db
      .insert(infoPages)
      .values({ id, ...fields, bodyMd: body, updatedBy: actorId, updatedAt: now })
      .onConflictDoNothing({ target: infoPages.slug }),
    auditInsertWhere(
      database.db,
      { actorId, action: 'info.create', entityType: 'info_page', entityId: id, createdAt: now },
      exists(eq(infoPages.id, id)),
    ),
  ]);
  if ((inserted?.changes ?? 0) === 0) return undefined;
  return findInfoPage(database, { id });
}

/**
 * Applies `patch` and its audit row (`info.pin` for a pin-only change, else `info.update`)
 * under one condition: the page exists and no other page has the new slug.
 */
export async function updateInfoPage(
  database: Database,
  id: string,
  patch: InfoPatch,
  actorId: string,
  now: number,
): Promise<'updated' | 'not_found' | 'slug_taken'> {
  const free =
    patch.slug === undefined
      ? undefined
      : sql`not ${exists(and(eq(infoPages.slug, patch.slug), ne(infoPages.id, id)))}`;
  const condition = and(eq(infoPages.id, id), free);
  const pinOnly = Object.keys(patch).every((key) => key === 'isPinned');
  const { body, ...rest } = patch;
  const [, updated] = await database.batch([
    auditInsertWhere(
      database.db,
      {
        actorId,
        action: pinOnly ? 'info.pin' : 'info.update',
        entityType: 'info_page',
        entityId: id,
        createdAt: now,
      },
      exists(condition),
    ),
    database.db
      .update(infoPages)
      .set({
        ...rest,
        ...(body !== undefined ? { bodyMd: body } : {}),
        updatedBy: actorId,
        updatedAt: now,
      })
      .where(condition),
  ]);
  if ((updated?.changes ?? 0) > 0) return 'updated';
  return (await findInfoPage(database, { id })) ? 'slug_taken' : 'not_found';
}

/** R-BRD-02: a hard delete (no soft-delete column) with its `info.delete` audit row. */
export async function deleteInfoPage(
  database: Database,
  id: string,
  actorId: string,
  now: number,
): Promise<boolean> {
  const [, deleted] = await database.batch([
    auditInsertWhere(
      database.db,
      { actorId, action: 'info.delete', entityType: 'info_page', entityId: id, createdAt: now },
      exists(eq(infoPages.id, id)),
    ),
    database.db.delete(infoPages).where(eq(infoPages.id, id)),
  ]);
  return (deleted?.changes ?? 0) > 0;
}
