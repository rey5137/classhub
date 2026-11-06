import type { RequestEvent } from '@sveltejs/kit';
import * as reservations from '../../src/routes/api/v1/media/reservations/+server';
import * as upload from '../../src/routes/api/v1/media/reservations/[id]/[variant]/+server';
import * as complete from '../../src/routes/api/v1/media/reservations/[id]/complete/+server';
import * as release from '../../src/routes/api/v1/media/reservations/[id]/+server';
import * as delivery from '../../src/routes/api/v1/media/[id]/[variant]/+server';
import * as gallery from '../../src/routes/api/v1/media/+server';
import * as photo from '../../src/routes/api/v1/media/[id]/+server';
import * as albums from '../../src/routes/api/v1/albums/+server';
import * as album from '../../src/routes/api/v1/albums/[id]/+server';

type Handler = (event: RequestEvent) => Response | Promise<Response>;
type Module = Record<string, Handler>;
const routes: [RegExp, Module][] = [
  [/^\/api\/v1\/media\/reservations$/, reservations as unknown as Module],
  [/^\/api\/v1\/media\/reservations\/(?<id>[^/]+)\/complete$/, complete as unknown as Module],
  [
    /^\/api\/v1\/media\/reservations\/(?<id>[^/]+)\/(?<variant>[^/]+)$/,
    upload as unknown as Module,
  ],
  [/^\/api\/v1\/media\/reservations\/(?<id>[^/]+)$/, release as unknown as Module],
  [/^\/api\/v1\/media\/(?<id>[^/]+)\/(?<variant>[^/]+)$/, delivery as unknown as Module],
  [/^\/api\/v1\/media$/, gallery as unknown as Module],
  [/^\/api\/v1\/media\/(?<id>[^/]+)$/, photo as unknown as Module],
  [/^\/api\/v1\/albums$/, albums as unknown as Module],
  [/^\/api\/v1\/albums\/(?<id>[^/]+)$/, album as unknown as Module],
];
export async function resolveMediaRoute(event: RequestEvent) {
  for (const [pattern, module] of routes) {
    const match = pattern.exec(event.url.pathname);
    if (!match) continue;
    Object.assign(event.params, match.groups);
    const handler = module[event.request.method];
    if (handler) return handler(event);
  }
  return new Response(null, { status: 404 });
}
