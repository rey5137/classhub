import {
  infoCreateSchema,
  infoIdSchema,
  infoListSchema,
  infoMutationResponseSchema,
  infoPageSchema,
  infoPatchSchema,
  infoSlugParamsSchema,
  type InfoList,
  type InfoPage,
} from '../../contracts/info';
import type { Features } from '../../contracts/settings';
import type { Locale } from '../../i18n';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import { extractPhotoIds, renderMarkdown, type ReferencedPhoto } from '../markdown';
import { findReferencedPhotos } from '../repositories/discussions';
import {
  deleteInfoPage,
  findInfoPage,
  insertInfoPage,
  listInfoPages,
  listInfoPagesWithBody,
  updateInfoPage,
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
  // R-NAV-02: with memories off a photo reference names no gallery photo (no caption, no link).
  const photos = features.memories
    ? await findReferencedPhotos(context.database, extractPhotoIds([markdown]))
    : new Map<string, ReferencedPhoto>();
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

/** `GET /api/v1/info`. */
export async function listInfo(
  context: AppContext,
  member: Member,
): Promise<AdminResult<InfoList>> {
  if (!can(member, 'content.read')) return forbidden;
  const items = await listInfoPages(context.database);
  return { ok: true, status: 200, body: infoListSchema.parse({ items, nextCursor: null }) };
}

/** The `/admin` editor's pages with their Markdown; null for anyone but an admin. */
export async function adminInfoPages(context: AppContext, member: Member) {
  if (!can(member, 'settings.edit')) return null;
  return listInfoPagesWithBody(context.database);
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
