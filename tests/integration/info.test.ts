import { applyD1Migrations, env } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { infoListSchema, infoPageSchema, type InfoPage } from '../../src/lib/contracts/info';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import type { Member } from '../../src/lib/server/auth/membership';
import type { AppContext } from '../../src/lib/server/context';
import { auditEvents, infoPages, siteSettings } from '../../src/lib/server/db/schema';
import { defaultSettings } from '../../src/lib/server/services/settings';
import { seedDeletedMedia } from '../fixtures/housekeeping';
import type { Database } from '../../src/lib/server/ports/database';
import * as adminInfoRoute from '../../src/routes/api/v1/admin/info/+server';
import * as adminInfoByIdRoute from '../../src/routes/api/v1/admin/info/[id]/+server';
import * as infoRoute from '../../src/routes/api/v1/info/+server';
import * as infoBySlugRoute from '../../src/routes/api/v1/info/[slug]/+server';
import { actions as adminActions } from '../../src/routes/admin/+page.server';
import { load as infoPageLoad } from '../../src/routes/info/[slug]/+page.server';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { comparable, createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

type Handler = (event: RequestEvent) => Response | Promise<Response>;
type Module = Record<string, Handler>;

const routes: [RegExp, Module][] = [
  [/^\/api\/v1\/info$/, infoRoute as unknown as Module],
  [/^\/api\/v1\/info\/(?<slug>[^/]+)$/, infoBySlugRoute as unknown as Module],
  [/^\/api\/v1\/admin\/info$/, adminInfoRoute as unknown as Module],
  [/^\/api\/v1\/admin\/info\/(?<id>[^/]+)$/, adminInfoByIdRoute as unknown as Module],
];

async function resolveRoute(event: RequestEvent) {
  for (const [pattern, module] of routes) {
    const match = pattern.exec(event.url.pathname);
    if (!match) continue;
    Object.assign(event.params, match.groups);
    const handler = module[event.request.method];
    if (handler) return handler(event);
  }
  return new Response(null, { status: 404 });
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

async function create(body: Record<string, unknown>) {
  const response = await send('/api/v1/admin/info', 'POST', adminHeaders, body);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return infoPageSchema.parse(await response.json());
}

async function errorOf(response: Response) {
  return errorBodySchema.parse(await response.json()).error;
}

const titles = async () =>
  infoListSchema
    .parse(await (await send('/api/v1/info', 'GET', memberHeaders)).json())
    .items.map((item) => item.title);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  harness = await createHarness(database, { resolve: resolveRoute });
  memberHeaders = await harness.as(PEOPLE.active.email);
  adminHeaders = await harness.as(PEOPLE.admin.email);
});

beforeEach(async () => {
  await database.db.delete(infoPages);
  await database.db.delete(auditEvents);
  await database.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
});

describe('info pages (R-BRD-02)', () => {
  it('an admin creates a page members read with a sanitized body, audited without content', async () => {
    const page = await create({
      slug: 'reunion',
      title: 'Họp lớp 2026',
      body: '**Ngày** 12/7\n\n[map](https://maps.example.test) <script>alert(1)</script> [x](javascript:alert(1))',
    });
    expect(page).toMatchObject({ slug: 'reunion', isPinned: false, sortOrder: 0 });

    const read = await send('/api/v1/info/reunion', 'GET', memberHeaders);
    expect(read.status).toBe(200);
    const body: InfoPage = infoPageSchema.parse(await read.json());
    expect(body.bodyHtml).toContain('<strong>Ngày</strong>');
    expect(body.bodyHtml).toContain('href="https://maps.example.test"');
    expect(body.bodyHtml).not.toContain('<script');
    expect(body.bodyHtml).not.toContain('javascript:');
    // bodyHtml is rendered per read, never stored.
    const [row] = await database.db.select().from(infoPages);
    expect(Object.keys(row!)).not.toContain('bodyHtml');

    const [audit] = await database.db.select().from(auditEvents);
    expect(audit).toMatchObject({
      actorId: PEOPLE.admin.id,
      action: 'info.create',
      entityType: 'info_page',
      entityId: page.id,
    });
    expect(JSON.stringify(audit)).not.toContain('Họp');
  });

  it('lists pinned first, then sort order, then title', async () => {
    await create({ slug: 'c', title: 'Charlie', sortOrder: 1 });
    await create({ slug: 'b', title: 'Bravo', sortOrder: 1 });
    await create({ slug: 'a', title: 'Alpha', sortOrder: 2 });
    await create({ slug: 'z', title: 'Zulu', sortOrder: 5, isPinned: true });
    expect(await titles()).toEqual(['Zulu', 'Bravo', 'Charlie', 'Alpha']);
    const list = infoListSchema.parse(
      await (await send('/api/v1/info', 'GET', memberHeaders)).json(),
    );
    expect(list.nextCursor).toBeNull();
    expect(Object.keys(list.items[0]!)).not.toContain('bodyMd');
  });

  it('edits, pins and orders a page, auditing each change', async () => {
    const page = await create({ slug: 'notes', title: 'Notes' });
    const edited = await send(`/api/v1/admin/info/${page.id}`, 'PATCH', adminHeaders, {
      title: 'Ghi chú',
      slug: 'ghi-chu',
      body: '- một\n- hai',
      sortOrder: -3,
    });
    expect(edited.status).toBe(200);
    expect(infoPageSchema.parse(await edited.json())).toMatchObject({
      title: 'Ghi chú',
      slug: 'ghi-chu',
      sortOrder: -3,
      bodyHtml: '<ul><li>một</li><li>hai</li></ul>',
    });
    const pinned = await send(`/api/v1/admin/info/${page.id}`, 'PATCH', adminHeaders, {
      isPinned: true,
    });
    expect(infoPageSchema.parse(await pinned.json()).isPinned).toBe(true);
    // An empty patch changes and audits nothing.
    expect((await send(`/api/v1/admin/info/${page.id}`, 'PATCH', adminHeaders, {})).status).toBe(
      200,
    );

    const actions = (await database.db.select().from(auditEvents)).map((row) => row.action).sort();
    expect(actions).toEqual(['info.create', 'info.pin', 'info.update']);
    expect((await send('/api/v1/info/notes', 'GET', memberHeaders)).status).toBe(404);
    expect((await send('/api/v1/info/ghi-chu', 'GET', memberHeaders)).status).toBe(200);
  });

  it('deletes a page for good with an audit row; a second delete is not found', async () => {
    const page = await create({ slug: 'old', title: 'Old' });
    expect((await send(`/api/v1/admin/info/${page.id}`, 'DELETE', adminHeaders, {})).status).toBe(
      200,
    );
    expect(await database.db.select().from(infoPages)).toHaveLength(0);
    expect((await send('/api/v1/info/old', 'GET', memberHeaders)).status).toBe(404);
    const again = await send(`/api/v1/admin/info/${page.id}`, 'DELETE', adminHeaders, {});
    expect((await errorOf(again)).code).toBe('not_found');
    const actions = (await database.db.select().from(auditEvents)).map((row) => row.action).sort();
    expect(actions).toEqual(['info.create', 'info.delete']);
  });

  it('R-DB-05 a taken slug is a conflict on the slug field, on create and on edit', async () => {
    await create({ slug: 'reunion', title: 'Reunion' });
    const other = await create({ slug: 'other', title: 'Other' });

    const clash = await send('/api/v1/admin/info', 'POST', adminHeaders, {
      slug: 'reunion',
      title: 'Again',
    });
    expect(clash.status).toBe(409);
    expect(await errorOf(clash)).toMatchObject({ code: 'conflict', fields: { slug: 'taken' } });

    const renamed = await send(`/api/v1/admin/info/${other.id}`, 'PATCH', adminHeaders, {
      slug: 'reunion',
      title: 'Changed',
    });
    expect(await errorOf(renamed)).toMatchObject({ code: 'conflict', fields: { slug: 'taken' } });
    expect(await titles()).toEqual(['Other', 'Reunion']);
    // Keeping its own slug is not a clash.
    const same = await send(`/api/v1/admin/info/${other.id}`, 'PATCH', adminHeaders, {
      slug: 'other',
    });
    expect(same.status).toBe(200);
    expect((await database.db.select().from(auditEvents)).map((row) => row.action)).not.toContain(
      'info.delete',
    );
  });

  it('refuses bad slugs, titles, bodies and unknown keys field by field', async () => {
    for (const [body, field] of [
      [{ slug: 'Reunion', title: 'x' }, 'slug'],
      [{ slug: 'a'.repeat(41), title: 'x' }, 'slug'],
      [{ slug: '', title: 'x' }, 'slug'],
      [{ slug: 'a b', title: 'x' }, 'slug'],
      [{ slug: 'ok', title: ' ' }, 'title'],
      [{ slug: 'ok', title: 't'.repeat(161) }, 'title'],
      [{ slug: 'ok', title: 'x', body: 'b'.repeat(20_001) }, 'body'],
      [{ slug: 'ok', title: 'x', html: '<b>' }, '_'],
    ] as const) {
      const response = await send('/api/v1/admin/info', 'POST', adminHeaders, body);
      const error = await errorOf(response);
      expect(error.code, JSON.stringify(body)).toBe('validation');
      expect(Object.keys(error.fields ?? {}), JSON.stringify(body)).toContain(field);
    }
    expect(await database.db.select().from(infoPages)).toHaveLength(0);
  });

  it('members read but never write; the refusal is the uniform admin denial', async () => {
    const page = await create({ slug: 'rules', title: 'Rules' });
    const writes = [
      await send('/api/v1/admin/info', 'POST', memberHeaders, { slug: 'mine', title: 'Mine' }),
      await send(`/api/v1/admin/info/${page.id}`, 'PATCH', memberHeaders, { title: 'Mine' }),
      await send(`/api/v1/admin/info/${page.id}`, 'DELETE', memberHeaders, {}),
    ];
    const [first, ...rest] = await Promise.all(writes.map(comparable));
    expect(first!.status).toBe(403);
    for (const other of rest) expect(other).toEqual(first);
    expect(await titles()).toEqual(['Rules']);
    expect((await database.db.select().from(auditEvents)).map((row) => row.action)).toEqual([
      'info.create',
    ]);
  });

  it('an unknown or malformed slug is not found, on the API and the page', async () => {
    for (const slug of ['missing', 'NOT-A-SLUG']) {
      const response = await send(`/api/v1/info/${slug}`, 'GET', memberHeaders);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe('not_found');
    }
    const member = { id: PEOPLE.active.id, role: 'member', displayName: 'Active' } as Member;
    const load = (slug: string) =>
      infoPageLoad({
        locals: {
          member,
          context: { database } as unknown as AppContext,
          locale: 'en',
          settings: defaultSettings,
        },
        params: { slug },
      } as unknown as Parameters<typeof infoPageLoad>[0]);
    await expect(load('missing')).rejects.toMatchObject({ status: 404 });
    await create({ slug: 'here', title: 'Here', body: 'Hi' });
    await expect(load('here')).resolves.toMatchObject({
      page: { title: 'Here', bodyHtml: '<p>Hi</p>' },
    });
  });

  it('the /admin forms create, edit and delete through the same service, without JavaScript', async () => {
    const admin = { id: PEOPLE.admin.id, role: 'admin', displayName: 'Admin' } as Member;
    const run = (name: keyof typeof adminActions, fields: Record<string, string>) => {
      const body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.set(key, value);
      return (adminActions[name] as (event: unknown) => Promise<unknown>)({
        locals: {
          member: admin,
          context: { database } as unknown as AppContext,
          locale: 'en',
          settings: defaultSettings,
        },
        request: new Request(`${ORIGIN}/admin`, { method: 'POST', body }),
      });
    };
    expect(
      await run('infoCreate', {
        slug: 'reunion',
        title: 'Reunion',
        body: 'Hi',
        isPinned: 'on',
        sortOrder: '2',
      }),
    ).toEqual({ action: 'infoCreate', done: 'infoCreated' });
    const [row] = await database.db.select().from(infoPages);
    expect(row).toMatchObject({ slug: 'reunion', isPinned: true, sortOrder: 2 });

    // A refusal names the row it came from, so only that editor shows it.
    const refused = (await run('infoEdit', {
      id: row!.id,
      slug: 'Bad Slug',
      title: 'Reunion',
      sortOrder: 'x',
    })) as {
      status: number;
      data: { target: string; fields: Record<string, string> };
    };
    expect(refused.status).toBe(400);
    expect(refused.data.target).toBe(row!.id);
    expect(Object.keys(refused.data.fields).sort()).toEqual(['slug', 'sortOrder']);

    // An unticked box is unpinned.
    await run('infoEdit', {
      id: row!.id,
      slug: 'reunion',
      title: 'Họp lớp',
      body: 'Hi',
      sortOrder: '0',
    });
    expect((await database.db.select().from(infoPages))[0]).toMatchObject({
      title: 'Họp lớp',
      isPinned: false,
    });
    expect(await run('infoDelete', { id: row!.id })).toEqual({
      action: 'infoDelete',
      done: 'infoDeleted',
    });
    expect(await database.db.select().from(infoPages)).toHaveLength(0);
  });

  it('R-NAV-02 with memories off a photo reference names no gallery photo', async () => {
    const photo = await seedDeletedMedia(database, {
      deletedAt: null,
      caption: 'Lều xanh',
      createdAt: Date.now(),
    });
    await create({ slug: 'album', title: 'Album', body: `Xem [[photo:${photo.id}]]` });
    const read = async () =>
      infoPageSchema.parse(await (await send('/api/v1/info/album', 'GET', memberHeaders)).json())
        .bodyHtml;
    expect(await read()).toContain(`/memories/${photo.id}`);

    await database.db.insert(siteSettings).values({
      key: 'features',
      valueJson: JSON.stringify({ ...defaultSettings.features, memories: false }),
      updatedAt: Date.now(),
    });
    const off = await read();
    expect(off).not.toContain(photo.id);
    expect(off).not.toContain('Lều xanh');
  });
});
