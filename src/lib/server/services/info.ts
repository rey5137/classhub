import {
  infoCreateSchema,
  infoIdSchema,
  infoListSchema,
  infoMutationResponseSchema,
  infoPageSchema,
  infoPatchSchema,
  infoQuerySchema,
  infoSlugParamsSchema,
  type InfoList,
  type InfoPage,
} from '../../contracts/info';
import type { Features } from '../../contracts/settings';
import type { Locale } from '../../i18n';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import { decodeCursor, encodeCursor } from '../cursor';
import { extractPhotoIds, renderMarkdown } from '../markdown';
import { findReferencedPhotos } from '../repositories/discussions';
import {
  deleteInfoPage,
  findInfoPage,
  insertInfoPage,
  listInfoPages,
  listInfoPagesWithBody,
  listPinnedInfoPages,
  updateInfoPage,
  type InfoCursor,
  type InfoPageRow,
} from '../repositories/info';
import { parse, type AdminFailure, type AdminResult } from './admin';

// R-BRD-02: members read info pages; only admins write them (`settings.edit`, §3.3).

const forbidden: AdminFailure = { ok: false, code: 'forbidden' };
const notFound: AdminFailure = { ok: false, code: 'not_found' };
const slugTaken: AdminFailure = {
  ok: false,
  code: 'conflict',
  messageKey: 'info.error.slug_taken',
  fields: { slug: 'taken' },
};

/** Site-written Markdown (an info page, the welcome message) as sanitized HTML (R-BRD-03, 04). */
export async function renderSiteMarkdown(
  context: AppContext,
  markdown: string,
  features: Features,
  locale: Locale,
): Promise<string> {
  // R-NAV-02: with memories off a photo reference names no gallery photo (no caption, no link),
  // and renders as the "not shown" note.
  const photos = features.memories
    ? await findReferencedPhotos(context.database, extractPhotoIds([markdown]))
    : null;
  return renderMarkdown(markdown, { locale, photos });
}

async function toInfoPage(
  context: AppContext,
  row: InfoPageRow,
  features: Features,
  locale: Locale,
): Promise<InfoPage> {
  return infoPageSchema.parse({
    id: row.id,
    slug: row.slug,
    title: row.title,
    isPinned: row.isPinned,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt,
    bodyMd: row.bodyMd,
    bodyHtml: await renderSiteMarkdown(context, row.bodyMd, features, locale),
  });
}

function encodeInfoCursor(row: {
  isPinned: boolean;
  sortOrder: number;
  title: string;
  id: string;
}): string {
  return encodeCursor([row.isPinned ? 1 : 0, row.sortOrder, row.title, row.id]);
}

function decodeInfoCursor(cursor: string): InfoCursor | null {
  const value = decodeCursor(cursor);
  if (
    value?.length !== 4 ||
    (value[0] !== 0 && value[0] !== 1) ||
    typeof value[1] !== 'number' ||
    !Number.isInteger(value[1]) ||
    typeof value[2] !== 'string' ||
    typeof value[3] !== 'string'
  ) {
    return null;
  }
  return { isPinned: value[0] === 1, sortOrder: value[1], title: value[2], id: value[3] };
}

/** `GET /api/v1/info?cursor=&limit=&pinned=`. */
export async function listInfo(
  context: AppContext,
  member: Member,
  input: unknown = {},
): Promise<AdminResult<InfoList>> {
  if (!can(member, 'content.read')) return forbidden;
  const parsed = parse(infoQuerySchema, input);
  if (!parsed.ok) return parsed;
  const withBody = parsed.data.body !== undefined;
  if (withBody && !can(member, 'settings.edit')) return forbidden;
  const after = parsed.data.cursor ? decodeInfoCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !after)
    return { ok: false, code: 'validation', fields: { cursor: 'custom' } };
  const pinnedOnly = parsed.data.pinned !== undefined;
  const { rows, more } = withBody
    ? await listInfoPagesWithBody(context.database, { after, limit: parsed.data.limit })
    : await listInfoPages(context.database, {
        after,
        limit: parsed.data.limit,
        pinnedOnly,
        excludeSlug: pinnedOnly ? 'reunion' : undefined,
      });
  const last = rows.at(-1);
  return {
    ok: true,
    status: 200,
    body: infoListSchema.parse({
      items: rows,
      nextCursor: more && last ? encodeInfoCursor(last) : null,
    }),
  };
}

/** R-BRD-01: Home's pinned info links (`reunion` has its own card below). */
export async function pinnedInfo(
  context: AppContext,
  member: Member,
  cursor?: string | null,
): Promise<{ items: { slug: string; title: string }[]; nextCursor: string | null }> {
  if (!can(member, 'content.read')) return { items: [], nextCursor: null };
  const after = cursor ? decodeInfoCursor(cursor) : null;
  if (cursor && !after) return { items: [], nextCursor: null };
  const { rows, more } = await listPinnedInfoPages(context.database, { after });
  const last = rows.at(-1);
  return {
    items: rows.map(({ slug, title }) => ({ slug, title })),
    nextCursor: more && last ? encodeInfoCursor(last) : null,
  };
}

/** The `/admin` editor's pages with their Markdown; null for anyone but an admin. */
export async function adminInfoPages(context: AppContext, member: Member, cursor?: string | null) {
  if (!can(member, 'settings.edit')) return null;
  const after = cursor ? decodeInfoCursor(cursor) : null;
  if (cursor && !after) return { items: [], nextCursor: null };
  const { rows, more } = await listInfoPagesWithBody(context.database, { after });
  const last = rows.at(-1);
  return {
    items: rows,
    nextCursor: more && last ? encodeInfoCursor(last) : null,
  };
}

/** `GET /api/v1/info/:slug` and `/info/[slug]`. */
export async function getInfo(
  context: AppContext,
  member: Member,
  params: unknown,
  features: Features,
  locale: Locale = 'vi',
): Promise<AdminResult<InfoPage>> {
  if (!can(member, 'content.read')) return forbidden;
  const path = parse(infoSlugParamsSchema, params);
  if (!path.ok) return notFound;
  const row = await findInfoPage(context.database, { slug: path.data.slug });
  if (!row) return notFound;
  return { ok: true, status: 200, body: await toInfoPage(context, row, features, locale) };
}

/** `POST /api/v1/admin/info`. */
export async function createInfo(
  context: AppContext,
  member: Member,
  input: unknown,
  features: Features,
  locale: Locale = 'vi',
  now = Date.now(),
): Promise<AdminResult<InfoPage>> {
  if (!can(member, 'settings.edit')) return forbidden;
  const parsed = parse(infoCreateSchema, input);
  if (!parsed.ok) return parsed;
  const row = await insertInfoPage(context.database, parsed.data, member.id, now);
  if (!row) return slugTaken;
  return { ok: true, status: 201, body: await toInfoPage(context, row, features, locale) };
}

/** `PATCH /api/v1/admin/info/:id`: edit, pin and order. */
export async function editInfo(
  context: AppContext,
  member: Member,
  params: unknown,
  input: unknown,
  features: Features,
  locale: Locale = 'vi',
  now = Date.now(),
): Promise<AdminResult<InfoPage>> {
  if (!can(member, 'settings.edit')) return forbidden;
  const path = parse(infoIdSchema, params);
  if (!path.ok) return notFound;
  const parsed = parse(infoPatchSchema, input);
  if (!parsed.ok) return parsed;
  if (Object.keys(parsed.data).length > 0) {
    const outcome = await updateInfoPage(
      context.database,
      path.data.id,
      parsed.data,
      member.id,
      now,
    );
    if (outcome === 'slug_taken') return slugTaken;
    if (outcome === 'not_found') return notFound;
  }
  const row = await findInfoPage(context.database, { id: path.data.id });
  if (!row) return notFound;
  return { ok: true, status: 200, body: await toInfoPage(context, row, features, locale) };
}

/** `DELETE /api/v1/admin/info/:id`: gone for good, with an audit row. */
export async function removeInfo(
  context: AppContext,
  member: Member,
  params: unknown,
  now = Date.now(),
): Promise<AdminResult<{ ok: true }>> {
  if (!can(member, 'settings.edit')) return forbidden;
  const path = parse(infoIdSchema, params);
  if (!path.ok) return notFound;
  if (!(await deleteInfoPage(context.database, path.data.id, member.id, now))) return notFound;
  return { ok: true, status: 200, body: infoMutationResponseSchema.parse({ ok: true }) };
}
