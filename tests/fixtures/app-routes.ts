import type { RequestEvent } from '@sveltejs/kit';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { load as rootLayout } from '../../src/routes/+layout.server';
import { load as homeLoad } from '../../src/routes/+page.server';
import { load as adminLoad } from '../../src/routes/admin/+page.server';
import { load as adminSetupLoad } from '../../src/routes/admin/setup/+page.server';
import * as albumsRoute from '../../src/routes/api/v1/albums/+server';
import * as adminInvitesRoute from '../../src/routes/api/v1/admin/invites/+server';
import * as adminJoinRequestsRoute from '../../src/routes/api/v1/admin/join-requests/+server';
import * as adminSettingsRoute from '../../src/routes/api/v1/admin/settings/+server';
import * as chatMessagesRoute from '../../src/routes/api/v1/chat/messages/+server';
import * as infoRoute from '../../src/routes/api/v1/info/+server';
import * as infoBySlugRoute from '../../src/routes/api/v1/info/[slug]/+server';
import * as meRoute from '../../src/routes/api/v1/me/+server';
import * as meExportRoute from '../../src/routes/api/v1/me/export/+server';
import * as mediaRoute from '../../src/routes/api/v1/media/+server';
import * as mediaVariantRoute from '../../src/routes/api/v1/media/[id]/[variant]/+server';
import * as reservationsRoute from '../../src/routes/api/v1/media/reservations/+server';
import * as membersRoute from '../../src/routes/api/v1/members/+server';
import * as memberRoute from '../../src/routes/api/v1/members/[id]/+server';
import * as notificationsRoute from '../../src/routes/api/v1/notifications/+server';
import * as postsRoute from '../../src/routes/api/v1/posts/+server';
import * as postRoute from '../../src/routes/api/v1/posts/[id]/+server';
import * as postCommentsRoute from '../../src/routes/api/v1/posts/[id]/comments/+server';
import * as healthRoute from '../../src/routes/health/+server';
import * as manifestRoute from '../../src/routes/manifest.webmanifest/+server';
import { load as chatLayout } from '../../src/routes/chat/+layout.server';
import { load as chatLoad } from '../../src/routes/chat/+page.server';
import { load as discussionsLayout } from '../../src/routes/discussions/+layout.server';
import {
  actions as boardActions,
  load as boardLoad,
} from '../../src/routes/discussions/+page.server';
import { load as threadLoad } from '../../src/routes/discussions/[id]/+page.server';
import { load as infoPageLoad } from '../../src/routes/info/[slug]/+page.server';
import { load as joinLoad } from '../../src/routes/join/+page.server';
import { load as membersLoad } from '../../src/routes/members/+page.server';
import { load as memberPageLoad } from '../../src/routes/members/[id]/+page.server';
import { load as memoriesLayout } from '../../src/routes/memories/+layout.server';
import { load as galleryLoad } from '../../src/routes/memories/+page.server';
import { load as photoLoad } from '../../src/routes/memories/[id]/+page.server';
import { load as notificationsLoad } from '../../src/routes/notifications/+page.server';
import { load as profileLoad } from '../../src/routes/profile/+page.server';

// The GET side of every built route, matched by path the way SvelteKit does. The row
// budget and D1-failure suites (AC-BUD-02, AC-BUD-04) drive the real loaders and
// handlers through the real pipeline; only rendering is stood in for.

type Load = (event: RequestEvent) => unknown;
type Handler = (event: RequestEvent) => Response | Promise<Response>;
type Module = Record<string, Handler>;

interface Page {
  pattern: RegExp;
  /** Layout loads run first, as SvelteKit runs them. */
  layouts: Load[];
  load: Load | null;
  actions?: Record<string, Load>;
}

const page = (
  pattern: RegExp,
  load: Load | null,
  layouts: Load[] = [],
  actions?: Record<string, Load>,
): Page => ({
  pattern,
  layouts,
  load,
  actions,
});

const pages: Page[] = [
  page(/^\/$/, homeLoad as unknown as Load),
  page(/^\/admin$/, adminLoad as unknown as Load),
  page(/^\/admin\/setup$/, adminSetupLoad as unknown as Load),
  page(/^\/chat$/, chatLoad as unknown as Load, [chatLayout as unknown as Load]),
  page(
    /^\/discussions$/,
    boardLoad as unknown as Load,
    [discussionsLayout as unknown as Load],
    boardActions as unknown as Record<string, Load>,
  ),
  page(/^\/discussions\/(?<id>[^/]+)$/, threadLoad as unknown as Load, [
    discussionsLayout as unknown as Load,
  ]),
  page(/^\/info\/(?<slug>[^/]+)$/, infoPageLoad as unknown as Load),
  page(/^\/join$/, joinLoad as unknown as Load),
  page(/^\/members$/, membersLoad as unknown as Load),
  page(/^\/members\/(?<id>[^/]+)$/, memberPageLoad as unknown as Load),
  page(/^\/memories$/, galleryLoad as unknown as Load, [memoriesLayout as unknown as Load]),
  page(/^\/memories\/(?<id>[^/]+)$/, photoLoad as unknown as Load, [
    memoriesLayout as unknown as Load,
  ]),
  page(/^\/notifications$/, notificationsLoad as unknown as Load),
  page(/^\/profile$/, profileLoad as unknown as Load),
  // Pages with no server load: the pipeline and the renderer alone.
  page(/^\/(denied|locked|install|privacy)$/, null),
];

const api: [RegExp, Module][] = [
  [/^\/health$/, healthRoute as unknown as Module],
  [/^\/manifest\.webmanifest$/, manifestRoute as unknown as Module],
  [/^\/api\/v1\/me$/, meRoute as unknown as Module],
  [/^\/api\/v1\/me\/export$/, meExportRoute as unknown as Module],
  [/^\/api\/v1\/members$/, membersRoute as unknown as Module],
  [/^\/api\/v1\/members\/(?<id>[^/]+)$/, memberRoute as unknown as Module],
  [/^\/api\/v1\/info$/, infoRoute as unknown as Module],
  [/^\/api\/v1\/info\/(?<slug>[^/]+)$/, infoBySlugRoute as unknown as Module],
  [/^\/api\/v1\/posts$/, postsRoute as unknown as Module],
  [/^\/api\/v1\/posts\/(?<id>[^/]+)$/, postRoute as unknown as Module],
  [/^\/api\/v1\/posts\/(?<id>[^/]+)\/comments$/, postCommentsRoute as unknown as Module],
  [/^\/api\/v1\/albums$/, albumsRoute as unknown as Module],
  [/^\/api\/v1\/media$/, mediaRoute as unknown as Module],
  [/^\/api\/v1\/media\/reservations$/, reservationsRoute as unknown as Module],
  [/^\/api\/v1\/media\/(?<id>[^/]+)\/(?<variant>[^/]+)$/, mediaVariantRoute as unknown as Module],
  [/^\/api\/v1\/chat\/messages$/, chatMessagesRoute as unknown as Module],
  [/^\/api\/v1\/notifications$/, notificationsRoute as unknown as Module],
  [/^\/api\/v1\/admin\/settings$/, adminSettingsRoute as unknown as Module],
  [/^\/api\/v1\/admin\/invites$/, adminInvitesRoute as unknown as Module],
  [/^\/api\/v1\/admin\/join-requests$/, adminJoinRequestsRoute as unknown as Module],
];

/** A load result or refusal as JSON, standing in for the renderer. */
function rendered(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refusal(error: unknown): Response {
  if (isRedirect(error)) {
    return new Response(null, { status: error.status, headers: { location: error.location } });
  }
  if (isHttpError(error)) return rendered({ error: 'route error' }, error.status);
  throw error;
}

async function pageResponse(event: RequestEvent): Promise<Response | null> {
  const pathname = event.url.pathname.replace(/\/__data\.json$/, '') || '/';
  const match = pages.find((candidate) => candidate.pattern.test(pathname));
  if (!match) return null;
  Object.assign(event.params, match.pattern.exec(pathname)?.groups ?? {});
  if (event.request.method === 'POST') {
    const actionName = [...event.url.searchParams.keys()]
      .find((key) => key.startsWith('/'))
      ?.slice(1);
    const action = actionName ? match.actions?.[actionName] : undefined;
    if (!action) return null;
    try {
      return rendered(await action(event));
    } catch (error) {
      return refusal(error);
    }
  }
  if (event.request.method !== 'GET') return null;
  try {
    await rootLayout(event as never);
    for (const layout of match.layouts) await layout(event);
    if (!match.load) return rendered(null);
    return rendered(await match.load(event));
  } catch (error) {
    return refusal(error);
  }
}

async function apiResponse(event: RequestEvent): Promise<Response | null> {
  for (const [pattern, module] of api) {
    const match = pattern.exec(event.url.pathname);
    if (!match) continue;
    const handler = module[event.request.method];
    if (!handler) continue;
    Object.assign(event.params, match.groups ?? {});
    return handler(event);
  }
  return null;
}

/** The real route for a request path, or a 404 when nothing is built there. */
export async function resolveAppRoute(event: RequestEvent): Promise<Response> {
  const apiMatched = await apiResponse(event);
  if (apiMatched) return apiMatched;
  const pageMatched = await pageResponse(event);
  return pageMatched ?? new Response('no route', { status: 404 });
}
