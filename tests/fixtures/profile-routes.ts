import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { invites, media, profileContacts, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { normalizeName } from '../../src/lib/shared/normalize';
import * as invitesApi from '../../src/routes/api/v1/admin/invites/+server';
import * as adminMemberApi from '../../src/routes/api/v1/admin/members/[id]/+server';
import * as deletionApi from '../../src/routes/api/v1/me/deletion-request/+server';
import * as exportApi from '../../src/routes/api/v1/me/export/+server';
import * as meApi from '../../src/routes/api/v1/me/+server';
import * as memberApi from '../../src/routes/api/v1/members/[id]/+server';
import * as membersApi from '../../src/routes/api/v1/members/+server';
import { actions as adminActions } from '../../src/routes/admin/+page.server';
import { load as memberLoad } from '../../src/routes/members/[id]/+page.server';
import { load as membersLoad } from '../../src/routes/members/+page.server';
import {
  actions as profileActions,
  load as profileLoad,
} from '../../src/routes/profile/+page.server';
import { PEOPLE } from './membership';

// The §4 routes and the admin routes they meet, resolved by path the way SvelteKit
// would, with `:id` filled into `params`.

type Handler = (event: RequestEvent) => Response | Promise<Response>;
type Module = Record<string, Handler>;
const routes: [RegExp, Module][] = [
  [/^\/api\/v1\/me$/, meApi as unknown as Module],
  [/^\/api\/v1\/me\/export$/, exportApi as unknown as Module],
  [/^\/api\/v1\/me\/deletion-request$/, deletionApi as unknown as Module],
  [/^\/api\/v1\/members$/, membersApi as unknown as Module],
  [/^\/api\/v1\/members\/(?<id>[^/]+)$/, memberApi as unknown as Module],
  [/^\/api\/v1\/admin\/invites$/, invitesApi as unknown as Module],
  [/^\/api\/v1\/admin\/members\/(?<id>[^/]+)$/, adminMemberApi as unknown as Module],
];

type Load = (event: RequestEvent) => Promise<unknown>;
const pages: [RegExp, Load][] = [
  [/^\/members$/, membersLoad as unknown as Load],
  [/^\/members\/(?<id>[^/]+)$/, memberLoad as unknown as Load],
  [/^\/profile$/, profileLoad as unknown as Load],
];

/** A page's load data or a form action's result as JSON, standing in for the renderer. */
async function page(event: RequestEvent): Promise<Response | null> {
  const asJson = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const forms = { '/profile': profileActions, '/admin': adminActions } as Record<
    string,
    Record<string, unknown>
  >;
  const actions = forms[event.url.pathname];
  if (actions && event.request.method === 'POST') {
    const action = actions[event.url.search.replace(/^\?\//, '')] as Load;
    const result = (await action(event)) as { status?: number; data?: unknown };
    // An ActionFailure carries its status and data; a success is the returned object.
    const failed = result && typeof result.status === 'number' && 'data' in result;
    return asJson(failed ? result.data : result, failed ? result.status : 200);
  }
  if (event.request.method !== 'GET') return null;
  for (const [pattern, load] of pages) {
    const match = pattern.exec(event.url.pathname);
    if (!match) continue;
    Object.assign(event.params, match.groups ?? {});
    try {
      return asJson(await load(event));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === 'number') return asJson({ error: String(status) }, status);
      throw error;
    }
  }
  return null;
}

export async function resolveProfileRoute(event: RequestEvent): Promise<Response> {
  const rendered = await page(event);
  if (rendered) return rendered;
  for (const [pattern, module] of routes) {
    const match = pattern.exec(event.url.pathname);
    const handler = match && module[event.request.method];
    if (!handler) continue;
    Object.assign(event.params, match.groups ?? {});
    return handler(event);
  }
  return new Response('no route', { status: 404 });
}

let counter = 0;

/** An active member with an accepted invite (as a real one has), optionally with contacts. */
export async function addMember(
  database: Database,
  name: string,
  options: {
    role?: 'member' | 'admin';
    status?: 'active' | 'suspended' | 'invited';
    preferredName?: string;
    contacts?: Partial<typeof profileContacts.$inferInsert>;
  } = {},
): Promise<{ id: string; email: string }> {
  counter += 1;
  const id = `01900000-0000-7000-8000-${String(counter).padStart(4, '0')}0000beef`;
  const email = `${normalizeName(name).replaceAll(' ', '.')}.${counter}@example.test`;
  const now = Date.now();
  await database.db.insert(users).values({
    id,
    authEmail: email,
    displayName: name,
    displayNameNorm: normalizeName(name),
    preferredName: options.preferredName ?? null,
    preferredNameNorm: options.preferredName ? normalizeName(options.preferredName) : null,
    role: options.role ?? 'member',
    status: options.status ?? 'active',
    createdAt: now,
    updatedAt: now,
  });
  await database.db.insert(invites).values({
    id: `${id.slice(0, -4)}1e7e`,
    email,
    invitedBy: PEOPLE.admin.id,
    role: options.role ?? 'member',
    status: 'accepted',
    createdAt: now,
  });
  if (options.contacts) {
    await database.db.insert(profileContacts).values({ userId: id, ...options.contacts });
  }
  return { id, email };
}

const MEDIA_TYPES = ['photo', 'avatar', 'site'] as const;

/** One media row of each type owned by `ownerId` (no objects: only the rows matter here). */
export async function addMedia(database: Database, ownerId: string): Promise<void> {
  const now = Date.now();
  await database.db.insert(media).values(
    MEDIA_TYPES.map((mediaType, index) => ({
      id: `${ownerId.slice(0, -4)}0b0${index}`,
      ownerId,
      mediaType,
      objectKey: `${mediaType}/${ownerId}`,
      thumbKey: `${mediaType}/${ownerId}.thumb`,
      mimeType: 'image/webp',
      width: 10,
      height: 10,
      sizeBytes: 100,
      thumbSizeBytes: 10,
      sha256: 'a'.repeat(64),
      thumbSha256: 'b'.repeat(64),
      caption: `${mediaType} caption`,
      createdAt: now,
    })),
  );
}

/** Which of the owner's media rows are soft-deleted, by type. */
export async function mediaDeleted(
  database: Database,
  ownerId: string,
): Promise<Record<(typeof MEDIA_TYPES)[number], boolean>> {
  const rows = await database.db
    .select({ type: media.mediaType, deletedAt: media.deletedAt })
    .from(media)
    .where(eq(media.ownerId, ownerId));
  return Object.fromEntries(rows.map((row) => [row.type, row.deletedAt !== null])) as Record<
    (typeof MEDIA_TYPES)[number],
    boolean
  >;
}
