import { applyD1Migrations, env } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { eq, ne } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { siteSettingsSchema, type SiteSettings } from '../../src/lib/contracts/settings';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import type { Member } from '../../src/lib/server/auth/membership';
import type { AppContext } from '../../src/lib/server/context';
import {
  auditEvents,
  comments,
  media,
  posts,
  rateEvents,
  siteSettings,
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import {
  defaultSettings,
  effectiveSettings,
  updateSettings,
} from '../../src/lib/server/services/settings';
import { readSettingRows, writeSettings } from '../../src/lib/server/repositories/settings';
import { load as layoutLoad } from '../../src/routes/+layout.server';
import { actions as adminActions } from '../../src/routes/admin/+page.server';
import { load as chatLayout } from '../../src/routes/chat/+layout.server';
import { load as discussionsLayout } from '../../src/routes/discussions/+layout.server';
import { load as memoriesLayout } from '../../src/routes/memories/+layout.server';
import { load as boardLoad } from '../../src/routes/discussions/+page.server';
import { load as threadLoad } from '../../src/routes/discussions/[id]/+page.server';
import { load as galleryLoad } from '../../src/routes/memories/+page.server';
import { load as photoLoad } from '../../src/routes/memories/[id]/+page.server';
import * as invitesRoute from '../../src/routes/api/v1/admin/invites/+server';
import * as settingsRoute from '../../src/routes/api/v1/admin/settings/+server';
import * as postsRoute from '../../src/routes/api/v1/posts/+server';
import * as mediaByIdRoute from '../../src/routes/api/v1/media/[id]/+server';
import * as mediaBytesRoute from '../../src/routes/api/v1/media/[id]/[variant]/+server';
import * as reservationsRoute from '../../src/routes/api/v1/media/reservations/+server';
import * as postByIdRoute from '../../src/routes/api/v1/posts/[id]/+server';
import { seedDeletedMedia } from '../fixtures/housekeeping';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { comparable, createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

type Handler = (event: RequestEvent) => Response | Promise<Response>;
type Module = Record<string, Handler>;

const apiRoutes: [RegExp, Module][] = [
  [/^\/api\/v1\/admin\/settings$/, settingsRoute as unknown as Module],
  [/^\/api\/v1\/admin\/invites$/, invitesRoute as unknown as Module],
  [/^\/api\/v1\/posts$/, postsRoute as unknown as Module],
  [/^\/api\/v1\/posts\/(?<id>[^/]+)$/, postByIdRoute as unknown as Module],
  [/^\/api\/v1\/media\/reservations$/, reservationsRoute as unknown as Module],
  [/^\/api\/v1\/media\/(?<id>[^/]+)\/(?<variant>[^/]+)$/, mediaBytesRoute as unknown as Module],
  [/^\/api\/v1\/media\/(?<id>[^/]+)$/, mediaByIdRoute as unknown as Module],
];

/**
 * API routes run for real, matched on the decoded path as SvelteKit matches them; a page
 * renders the harness's app.html stand-in.
 */
async function resolveRoute(event: RequestEvent) {
  const pathname = decodeURI(event.url.pathname);
  if (!pathname.startsWith('/api/')) return renderPage(event);
  for (const [pattern, module] of apiRoutes) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    Object.assign(event.params, match.groups);
    const handler = module[event.request.method];
    if (handler) return handler(event);
  }
  return new Response(null, { status: 404 });
}

function renderPage(event: RequestEvent): Response {
  const html = `<!doctype html><html lang="%classhub.lang%" data-theme="%classhub.theme%" data-mode="%classhub.mode%" data-density="%classhub.density%"><head><link rel="icon" href="%classhub.favicon%" /><style>%classhub.accent%</style></head><body>${event.url.pathname}</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html' } });
}

let database: Database;
let harness: Harness;
let memberHeaders: Record<string, string>;
let adminHeaders: Record<string, string>;

const send = (path: string, method = 'GET', headers = adminHeaders, body?: unknown) =>
  harness.send(path, {
    method,
    headers: {
      ...headers,
      ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });

const patch = (body: unknown, headers = adminHeaders) =>
  send('/api/v1/admin/settings', 'PATCH', headers, body);

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; fields?: Record<string, string> } })
    .error;
}

const locals = (member: Member, settings: SiteSettings) => ({
  member,
  context: { database } as unknown as AppContext,
  locale: 'en',
  theme: settings.theme,
  mode: 'light',
  settings,
});

/** The root layout's nav, with the settings the pipeline would put on `locals`. */
async function navFor(member: Member, settings: SiteSettings) {
  const data = (await layoutLoad({ locals: locals(member, settings) } as unknown as Parameters<
    typeof layoutLoad
  >[0])) as { nav: { id: string }[] };
  return data.nav.map((item) => item.id);
}

const featureLayouts = {
  chat: chatLayout,
  discussions: discussionsLayout,
  memories: memoriesLayout,
};

/** A feature folder's own layout load, which 404s its pages while the feature is off. */
async function featurePage(
  feature: keyof typeof featureLayouts,
  member: Member,
  settings: SiteSettings,
) {
  const load = featureLayouts[feature] as (event: unknown) => unknown;
  return load({ locals: locals(member, settings) }) ?? 'shown';
}

const asMember = { id: PEOPLE.active.id, role: 'member', displayName: 'Active Member' } as Member;
const asAdmin = { id: PEOPLE.admin.id, role: 'admin', displayName: 'Admin' } as Member;
const ctx = {
  get database() {
    return database;
  },
} as unknown as AppContext;
const stored = async () => effectiveSettings(await readSettingRows(database.db));

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  harness = await createHarness(database, { resolve: resolveRoute, appearance: true });
  memberHeaders = await harness.as(PEOPLE.active.email);
  adminHeaders = await harness.as(PEOPLE.admin.email);
});

beforeEach(async () => {
  await database.db.delete(siteSettings).where(ne(siteSettings.key, 'setup_state'));
  await database.db.delete(auditEvents);
  await database.db.delete(comments);
  await database.db.delete(posts);
  await database.db.delete(rateEvents);
});

describe('site settings API (R-UI-01, R-UI-04)', () => {
  it('GET returns the Level B defaults until an admin sets anything', async () => {
    const response = await send('/api/v1/admin/settings');
    expect(response.status).toBe(200);
    expect(siteSettingsSchema.parse(await response.json())).toEqual(defaultSettings);
  });

  it('PATCH writes only the keys sent, with one settings.update audit row and no values', async () => {
    const response = await patch({ name: 'Lớp 12A', features: { chat: false } });
    expect(response.status).toBe(200);
    const body = siteSettingsSchema.parse(await response.json());
    expect(body).toEqual({
      ...defaultSettings,
      name: 'Lớp 12A',
      features: { ...defaultSettings.features, chat: false },
    });

    const rows = await database.db
      .select()
      .from(siteSettings)
      .where(ne(siteSettings.key, 'setup_state'));
    expect(rows.map((row) => row.key).sort()).toEqual(['features', 'name']);
    expect(rows.every((row) => row.updatedBy === PEOPLE.admin.id)).toBe(true);
    const audits = await database.db.select().from(auditEvents);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: PEOPLE.admin.id,
      action: 'settings.update',
      entityType: 'settings',
      entityId: 'site',
    });
    expect(JSON.stringify(audits[0])).not.toContain('12A');

    // A later PATCH keeps what it does not name; the read after it sees the write.
    await patch({ years: '2009–2012' });
    const again = siteSettingsSchema.parse(await (await send('/api/v1/admin/settings')).json());
    expect(again).toMatchObject({ name: 'Lớp 12A', years: '2009–2012' });
    expect(again.features.chat).toBe(false);
  });

  it('the same PATCH twice leaves the same settings', async () => {
    const first = await (await patch({ theme: 'minimal', density: 'compact' })).json();
    const second = await (await patch({ theme: 'minimal', density: 'compact' })).json();
    expect(second).toEqual(first);
    expect(await stored()).toEqual(first);
  });

  it('an empty PATCH changes nothing and writes no audit row', async () => {
    expect((await patch({})).status).toBe(200);
    expect(await database.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('AC-UI-04 refuses unknown keys, CSS, HTML, bad lengths and bad enums field by field', async () => {
    for (const [body, field] of [
      [{ colour: 'red' }, '_'],
      [{ name: 'x'.repeat(81) }, 'name'],
      [{ years: 'y'.repeat(41) }, 'years'],
      [{ description: 'd'.repeat(301) }, 'description'],
      [{ welcome: 'w'.repeat(2001) }, 'welcome'],
      [{ name: '<b>Class</b>' }, 'name'],
      [{ description: 'body { color: red }' }, 'description'],
      [{ welcome: 'Hi <script>alert(1)</script>' }, 'welcome'],
      [{ theme: 'neon' }, 'theme'],
      [{ mode: 'sepia' }, 'mode'],
      [{ density: 'tight' }, 'density'],
      [{ locale: 'fr' }, 'locale'],
      [{ accent: { light: 'red' } }, 'accent.light'],
      [{ features: { chat: 'off' } }, 'features.chat'],
      [{ features: { forum: true } }, 'features'],
    ] as const) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe('validation');
      expect(Object.keys(error.fields ?? {}), JSON.stringify(body)).toContain(field);
    }
    expect(await database.db.select().from(auditEvents)).toHaveLength(0);
    expect(await stored()).toEqual(defaultSettings);
  });

  it('AC-UI-04 refuses a low-contrast accent naming the ratio, and a key for a mode the theme lacks', async () => {
    const low = await errorOf(await patch({ theme: 'yearbook', accent: { light: '#8cc4ef' } }));
    expect(low.code).toBe('validation');
    expect(low.fields?.['accent.light']).toMatch(
      /measures \d+\.\d\d:1 against the yearbook light surface/,
    );

    const missing = await errorOf(await patch({ theme: 'night', accent: { light: '#1f4f9c' } }));
    expect(missing.fields?.['accent.light']).toMatch(/no light mode/);

    // A theme change re-checks the stored accent against the new theme.
    expect((await patch({ accent: { light: '#1f4f9c' } })).status).toBe(200);
    const switched = await errorOf(await patch({ theme: 'night' }));
    expect(switched.fields?.['accent.light']).toMatch(/no light mode/);
    expect((await patch({ theme: 'night', accent: { dark: '#ff8a6b' } })).status).toBe(200);
  });

  it('R-UI-01 a replaced or removed picture is retired unless another setting still shows it', async () => {
    const first = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    const second = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    const deletedAt = async (id: string) =>
      (await database.db.select().from(media).where(eq(media.id, id)))[0]?.deletedAt ?? null;

    expect((await patch({ logoMediaId: first.id, bannerMediaId: first.id })).status).toBe(200);
    // Still the banner, so replacing the logo keeps it.
    expect((await patch({ logoMediaId: second.id })).status).toBe(200);
    expect(await deletedAt(first.id)).toBeNull();
    expect(await stored()).toMatchObject({ logoMediaId: second.id, bannerMediaId: first.id });

    // Removed from its last setting, it goes in the same write.
    expect((await patch({ bannerMediaId: null })).status).toBe(200);
    expect(await deletedAt(first.id)).not.toBeNull();
    expect(await deletedAt(second.id)).toBeNull();

    // Moving a picture between settings keeps it.
    expect((await patch({ logoMediaId: null, faviconMediaId: second.id })).status).toBe(200);
    expect(await deletedAt(second.id)).toBeNull();
    // A refused write retires nothing.
    expect((await patch({ faviconMediaId: null, name: 'x'.repeat(81) })).status).toBe(400);
    expect(await deletedAt(second.id)).toBeNull();
  });

  it('R-UI-01 a settings write naming a picture deleted since the check writes nothing', async () => {
    const live = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    const gone = await seedDeletedMedia(database, { mediaType: 'site' });
    const previous = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    // As if `gone` had been deleted after updateSettings checked it.
    expect(
      await writeSettings(
        database,
        [
          ['logoMediaId', gone.id],
          ['name', 'Raced'],
        ],
        PEOPLE.admin.id,
        Date.now(),
        { retire: [previous.id], requireLive: [gone.id, live.id] },
      ),
    ).toBe(false);
    expect(await stored()).toEqual(defaultSettings);
    expect(await database.db.select().from(auditEvents)).toHaveLength(0);
    const [kept] = await database.db.select().from(media).where(eq(media.id, previous.id));
    expect(kept?.deletedAt).toBeNull();
    // The same write with every picture live goes through.
    expect(
      await writeSettings(database, [['logoMediaId', live.id]], PEOPLE.admin.id, Date.now(), {
        requireLive: [live.id],
      }),
    ).toBe(true);
    expect((await stored()).logoMediaId).toBe(live.id);
  });

  it('R-UI-01 a picture another setting took since the read stays live when the write retires it', async () => {
    const x = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    const y = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    expect((await patch({ bannerMediaId: x.id })).status).toBe(200);
    // Admin A read banner = X, then B sets the logo to X before A's write lands.
    const snapshot = await stored();
    expect((await patch({ logoMediaId: x.id })).status).toBe(200);
    const result = await updateSettings(ctx, asAdmin, snapshot, { bannerMediaId: y.id });
    expect(result.ok).toBe(true);
    const [row] = await database.db.select().from(media).where(eq(media.id, x.id));
    expect(row?.deletedAt).toBeNull();
    expect(await stored()).toMatchObject({ bannerMediaId: y.id, logoMediaId: x.id });
  });

  it('R-UI-01 two interleaved feature toggles both stick, including the first write on an empty table, and the reply shows what is stored', async () => {
    const snapshot = await stored();
    const a = await updateSettings(ctx, asAdmin, snapshot, { features: { memories: false } });
    const b = await updateSettings(ctx, asAdmin, snapshot, { features: { chat: false } });
    expect(a.ok && b.ok).toBe(true);
    expect(b.ok && b.body.features).toMatchObject({ memories: false, chat: false });
    expect((await stored()).features).toMatchObject({
      memories: false,
      chat: false,
      discussions: true,
    });
    // Turning one back on over a stale snapshot leaves the other off.
    const c = await updateSettings(ctx, asAdmin, snapshot, { features: { memories: true } });
    expect(c.ok && c.body.features).toMatchObject({ memories: true, chat: false });
    expect((await stored()).features).toMatchObject({ memories: true, chat: false });
  });

  it('R-UI-01 a feature patch of false values merges over a stored row', async () => {
    expect((await patch({ features: { discussions: false } })).status).toBe(200);
    const response = await patch({ features: { memories: false, chat: false } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { features: object }).features).toEqual({
      discussions: false,
      memories: false,
      chat: false,
    });
  });

  it('R-UI-01 DELETE /api/v1/media/:id refuses a site picture a setting names and removes an unused one', async () => {
    const used = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    const unused = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    await patch({ faviconMediaId: used.id });

    const refused = await send(`/api/v1/media/${used.id}`, 'DELETE', adminHeaders, {});
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe('conflict');
    expect((await send(`/api/v1/media/${unused.id}`, 'DELETE', memberHeaders, {})).status).toBe(
      403,
    );
    expect((await send(`/api/v1/media/${unused.id}`, 'DELETE', adminHeaders, {})).status).toBe(200);
    const rows = await database.db.select().from(media);
    expect(rows.find((row) => row.id === used.id)?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === unused.id)?.deletedAt).not.toBeNull();

    // Clearing the setting retires it with the write.
    await patch({ faviconMediaId: null });
    const [after] = await database.db.select().from(media).where(eq(media.id, used.id));
    expect(after?.deletedAt).not.toBeNull();
  });

  it('R-UI-01 banner, logo and favicon must name a live site media row', async () => {
    const site = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    const photo = await seedDeletedMedia(database, { mediaType: 'photo', deletedAt: null });
    const gone = await seedDeletedMedia(database, { mediaType: 'site' });

    const refused = await errorOf(
      await patch({ bannerMediaId: photo.id, logoMediaId: gone.id, faviconMediaId: 'not-a-uuid' }),
    );
    expect(refused.code).toBe('validation');
    expect(refused.fields).toHaveProperty('faviconMediaId');
    const both = await errorOf(await patch({ bannerMediaId: photo.id, logoMediaId: gone.id }));
    expect(both.fields).toEqual({ bannerMediaId: 'not_found', logoMediaId: 'not_found' });

    const ok = await patch({
      bannerMediaId: site.id,
      logoMediaId: site.id,
      faviconMediaId: site.id,
    });
    expect(ok.status).toBe(200);
    expect((await patch({ logoMediaId: null })).status).toBe(200);
    expect(await stored()).toMatchObject({ bannerMediaId: site.id, logoMediaId: null });
  });

  it('members get the uniform denial for both routes, and nothing is written', async () => {
    const denied = await comparable(await patch({ name: 'Taken over' }, memberHeaders));
    const otherAdminRoute = await comparable(
      await send('/api/v1/admin/invites', 'POST', memberHeaders, { email: 'x@example.test' }),
    );
    expect(denied.status).toBe(403);
    expect(denied).toEqual(otherAdminRoute);
    expect(await comparable(await send('/api/v1/admin/settings', 'GET', memberHeaders))).toEqual(
      await comparable(await send('/api/v1/admin/invites', 'GET', memberHeaders)),
    );
    expect(await stored()).toEqual(defaultSettings);
    expect(await database.db.select().from(auditEvents)).toHaveLength(0);
  });
});

describe('effective settings in the server render (R-UI-08, R-UI-10)', () => {
  it('a PATCHed theme, mode, accent, density and language reach <html> on the next request', async () => {
    const before = await (await send('/members', 'GET', memberHeaders)).text();
    expect(before).toContain('data-theme="yearbook" data-mode="light" data-density="comfortable"');
    expect(before).toContain('lang="vi"');

    await patch({
      theme: 'minimal',
      mode: 'dark',
      accent: { dark: '#8cc4ef' },
      density: 'compact',
      locale: 'en',
    });
    const after = await (await send('/members', 'GET', memberHeaders)).text();
    expect(after).toContain(
      'lang="en" data-theme="minimal" data-mode="dark" data-density="compact"',
    );
    expect(after).toContain('--color-accent: #8cc4ef');

    // The member's own language cookie wins over the admin's default.
    const own = await harness.send('/members', {
      headers: memberHeaders,
      cookies: { 'classhub.locale': 'vi' },
    });
    expect(await own.text()).toContain('lang="vi"');
  });

  it('public pages wear the theme but never the private favicon; members get it', async () => {
    const site = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    await patch({ theme: 'night', faviconMediaId: site.id });

    const denied = await harness.send('/denied');
    expect(denied.status).toBe(403);
    const html = await denied.text();
    expect(html).toContain('data-theme="night" data-mode="dark"');
    expect(html).toContain('href="/favicon.svg"');
    expect(html).not.toContain(site.id);

    const member = await (await send('/members', 'GET', memberHeaders)).text();
    expect(member).toContain(`href="/api/v1/media/${site.id}/image"`);
  });
});

describe('feature toggles (R-NAV-02)', () => {
  it('AC-NAV-04 disabling chat hides it, answers feature_disabled and 404, and re-enabling restores it', async () => {
    const on = await stored();
    expect(await navFor(asMember, on)).toContain('chat');
    // No chat API exists yet (4a); with the feature on the request reaches routing.
    expect((await send('/api/v1/chat/messages', 'GET', memberHeaders)).status).toBe(404);
    expect(harness.resolved).toContain('GET /api/v1/chat/messages');

    await patch({ features: { chat: false } });
    const off = await stored();
    expect(await navFor(asMember, off)).not.toContain('chat');
    await expect(featurePage('chat', asMember, off)).rejects.toMatchObject({ status: 404 });
    await expect(featurePage('discussions', asMember, off)).resolves.toBe('shown');
    for (const headers of [memberHeaders, adminHeaders]) {
      const api = await send('/api/v1/chat/messages', 'GET', headers);
      expect(api.status).toBe(404);
      expect((await errorOf(api)).code).toBe('feature_disabled');
      const post = await send('/chat', 'POST', headers, {});
      expect((await errorOf(post)).code).toBe('not_found');
    }
    // Other areas are untouched.
    expect(await navFor(asMember, off)).toContain('members');

    await patch({ features: { chat: true } });
    const back = await stored();
    expect(await navFor(asMember, back)).toContain('chat');
    await expect(featurePage('chat', asMember, back)).resolves.toBe('shown');
  });

  it('AC-NAV-04 discussions off hides the threads and their API; on again shows the same ones', async () => {
    const created = await send('/api/v1/posts', 'POST', memberHeaders, {
      title: 'Họp lớp',
      body: 'Ai đi không?',
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const list = async () => send('/api/v1/posts', 'GET', memberHeaders);
    const before = await (await list()).json();

    await patch({ features: { discussions: false } });
    for (const path of ['/api/v1/posts', `/api/v1/posts/${id}`]) {
      const response = await send(path, 'GET', memberHeaders);
      expect((await errorOf(response)).code).toBe('feature_disabled');
    }
    expect(
      (await errorOf(await send(`/api/v1/posts/${id}`, 'DELETE', adminHeaders, {}))).code,
    ).toBe('feature_disabled');
    // A percent-encoded path routes to the same handlers; the check follows the matched route.
    for (const [path, routeId, method] of [
      ['/api/v1/p%6Fsts', '/api/v1/posts', 'GET'],
      [`/api/v1/p%6Fsts/${id}`, '/api/v1/posts/[id]', 'GET'],
      [`/api/v1/p%6Fsts/${id}`, '/api/v1/posts/[id]', 'DELETE'],
    ] as const) {
      const response = await harness.send(path, {
        method,
        routeId,
        headers: {
          ...adminHeaders,
          ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
        },
        body: method === 'GET' ? null : '{}',
      });
      expect((await errorOf(response)).code, `${method} ${path}`).toBe('feature_disabled');
    }
    // /discussions and /discussions/[id] share the folder's layout.
    await expect(featurePage('discussions', asMember, await stored())).rejects.toMatchObject({
      status: 404,
    });
    expect(await navFor(asMember, await stored())).not.toContain('discussions');
    expect(await database.db.select().from(posts).where(eq(posts.id, id))).toHaveLength(1);

    await patch({ features: { discussions: true } });
    expect(await (await list()).json()).toEqual(before);
  });

  it('AC-NAV-04 each discussions and memories page load is a 404 with its flag off', async () => {
    const created = await send('/api/v1/posts', 'POST', memberHeaders, {
      title: 'Họp lớp',
      body: 'Ai đi không?',
    });
    const { id: threadId } = (await created.json()) as { id: string };
    const photo = await seedDeletedMedia(database, { ownerId: PEOPLE.active.id, deletedAt: null });
    const loads = [
      [boardLoad, {}],
      [threadLoad, { id: threadId }],
      [galleryLoad, {}],
      [photoLoad, { id: photo.id }],
    ] as const;
    const run = async (settings: SiteSettings) => {
      for (const [load, params] of loads) {
        const event = { locals: locals(asMember, settings), params, url: new URL(ORIGIN) };
        await (load as (e: unknown) => unknown)(event);
      }
    };
    // With the flags on, the same loads succeed, so a 404 below comes from the flag.
    await patch({ features: { discussions: true, memories: true } });
    await expect(run(await stored())).resolves.toBeUndefined();
    await patch({ features: { discussions: false, memories: false } });
    const off = await stored();
    for (const [load, params] of loads) {
      const event = { locals: locals(asMember, off), params, url: new URL(ORIGIN) };
      await expect((load as (e: unknown) => unknown)(event)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it('memories off refuses the gallery and its photos but not site pictures', async () => {
    const photo = await seedDeletedMedia(database, { ownerId: PEOPLE.active.id, deletedAt: null });
    const site = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    await patch({ features: { memories: false } });
    for (const path of ['/api/v1/media', '/api/v1/albums']) {
      const response = await send(path, 'GET', memberHeaders);
      expect((await errorOf(response)).code, path).toBe('feature_disabled');
    }
    // A gallery photo answers exactly like an unknown id (no probing which ids are photos).
    const photoPath = `/api/v1/media/${photo.id}`;
    const unknownPath = `/api/v1/media/${PEOPLE.suspended.id}`;
    for (const [method, body] of [
      ['PATCH', { caption: 'x' }],
      ['DELETE', {}],
    ] as const) {
      expect(await comparable(await send(photoPath, method, memberHeaders, body))).toEqual(
        await comparable(await send(unknownPath, method, memberHeaders, body)),
      );
    }
    const thumb = await send(`${photoPath}/thumb`, 'GET', memberHeaders);
    expect(thumb.status).toBe(404);
    expect((await errorOf(thumb)).code).toBe('not_found');
    const reservation = await send('/api/v1/media/reservations', 'POST', memberHeaders, {
      purpose: 'photo',
      imageBytes: 10,
      thumbBytes: 5,
      sha256: 'a'.repeat(64),
      thumbSha256: 'b'.repeat(64),
      mimeType: 'image/webp',
      width: 10,
      height: 10,
    });
    expect((await errorOf(reservation)).code).toBe('feature_disabled');
    // R-UI-01: an unused site picture is the admin's, not the gallery's.
    expect((await send(`/api/v1/media/${site.id}`, 'DELETE', adminHeaders, {})).status).toBe(200);
    const rows = await database.db.select().from(media);
    expect(rows.find((row) => row.id === photo.id)?.deletedAt).toBeNull();
    await expect(featurePage('memories', asMember, await stored())).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('the /admin settings form (R-UI-01, R-AUTH-17)', () => {
  const admin = { id: PEOPLE.admin.id, role: 'admin', displayName: 'Class Admin' } as Member;
  async function submit(name: 'settings' | 'settingsMedia', fields: Record<string, string>) {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const event = {
      locals: {
        member: admin,
        context: { database } as unknown as AppContext,
        locale: 'en',
        settings: await stored(),
        theme: 'yearbook',
        mode: 'light',
      },
      request: new Request(`${ORIGIN}/admin`, { method: 'POST', body }),
      url: new URL(`${ORIGIN}/admin`),
      cookies: { get: () => undefined },
    };
    const result = await (adminActions[name] as (event: unknown) => Promise<unknown>)(event);
    return { result, locals: event.locals };
  }
  const full = {
    name: 'Lớp 12A',
    years: '2009–2012',
    description: '',
    welcome: 'Chào **cả lớp**',
    theme: 'minimal',
    mode: 'dark',
    'accent-light': '',
    'accent-dark': '#8CC4EF',
    density: 'compact',
    locale: 'en',
    memories: 'on',
    chat: 'on',
  };

  it('saves every field without JavaScript and renders the new theme in the same response', async () => {
    const { result, locals } = await submit('settings', full);
    expect(result).toEqual({ action: 'settings', done: 'settingsSaved' });
    const expected = {
      ...defaultSettings,
      name: 'Lớp 12A',
      years: '2009–2012',
      welcome: 'Chào **cả lớp**',
      theme: 'minimal',
      mode: 'dark',
      accent: { dark: '#8cc4ef' },
      density: 'compact',
      locale: 'en',
      features: { memories: true, discussions: false, chat: true },
    };
    expect(await stored()).toEqual(expected);
    expect(locals).toMatchObject({
      settings: expected,
      theme: 'minimal',
      mode: 'dark',
      locale: 'en',
    });
  });

  it("R-UI-01 a save from a stale page does not revert another admin's feature toggle", async () => {
    await patch({ features: { memories: true, discussions: true, chat: true } });
    // Admin A loaded the page with every feature on; B then turns memories off.
    const loaded = { 'was-memories': 'on', 'was-discussions': 'on', 'was-chat': 'on' };
    await patch({ features: { memories: false } });
    // A unticks chat (memories and discussions stay ticked, as loaded).
    const stale = { ...full, ...loaded, memories: 'on', discussions: 'on' };
    delete (stale as Record<string, string>).chat;
    expect((await submit('settings', stale)).result).toEqual({
      action: 'settings',
      done: 'settingsSaved',
    });
    expect((await stored()).features).toEqual({ memories: false, discussions: true, chat: false });
  });

  it("R-UI-01 a save with no flag changed leaves every flag; a changed flag applies; a forged was- is only A's own change", async () => {
    await patch({ features: { memories: true, discussions: false, chat: true } });
    const same = { ...full, 'was-memories': 'on', 'was-discussions': '', 'was-chat': 'on' };
    await submit('settings', { ...same, name: 'Tên mới' });
    expect(await stored()).toMatchObject({
      name: 'Tên mới',
      features: { memories: true, discussions: false, chat: true },
    });
    await submit('settings', { ...same, discussions: 'on' });
    expect((await stored()).features).toEqual({ memories: true, discussions: true, chat: true });
    // Forging was-chat as already off while the box is ticked changes nothing.
    await submit('settings', { ...same, discussions: 'on', 'was-chat': '' });
    expect((await stored()).features.chat).toBe(true);
  });

  it('sends only the accent boxes the chosen theme ships, and names the contrast ratio', async () => {
    // Night has no light mode: a stale light box is not sent.
    await submit('settings', {
      ...full,
      theme: 'night',
      'accent-light': '#1f4f9c',
      'accent-dark': '',
    });
    expect(await stored()).toMatchObject({ theme: 'night', accent: null });
    const { result } = await submit('settings', { ...full, 'accent-light': '#8cc4ef' });
    const failure = result as { status: number; data: { fields: Record<string, string> } };
    expect(failure.status).toBe(400);
    expect(failure.data.fields['accent.light']).toMatch(/\d+\.\d\d:1/);
  });

  it('removes a picture without JavaScript, retiring it', async () => {
    const site = await seedDeletedMedia(database, { mediaType: 'site', deletedAt: null });
    await patch({ logoMediaId: site.id });
    expect((await submit('settingsMedia', { remove: 'logoMediaId' })).result).toEqual({
      action: 'settings',
      done: 'settingsSaved',
    });
    expect((await stored()).logoMediaId).toBeNull();
    const [row] = await database.db.select().from(media).where(eq(media.id, site.id));
    expect(row?.deletedAt).not.toBeNull();
    const refused = (await submit('settingsMedia', { remove: 'name' })).result as {
      status: number;
    };
    expect(refused.status).toBe(400);
  });
});
