import { applyD1Migrations, env } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { inviteListSchema } from '../../src/lib/contracts/admin';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { invites, siteSettings, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { takeRateLimit } from '../../src/lib/server/services/rate-limit';
import { actions as adminActions } from '../../src/routes/admin/+page.server';
import { load as setupLoad } from '../../src/routes/admin/setup/+page.server';
import * as invitesApi from '../../src/routes/api/v1/admin/invites/+server';
import * as membersApi from '../../src/routes/api/v1/admin/members/[id]/+server';
import { PEOPLE, seedMembership, setSetupState } from '../fixtures/membership';
import { createHarness, ORIGIN, recordingHub, type Harness } from '../fixtures/pipeline-harness';

// The admin routes through the real pipeline and their real handlers on D1.

type Handler = (event: RequestEvent) => Response | Promise<Response>;
const handlers: Record<string, Record<string, Handler>> = {
  '/api/v1/admin/invites': invitesApi as unknown as Record<string, Handler>,
  '/api/v1/admin/members': membersApi as unknown as Record<string, Handler>,
};

async function route(event: RequestEvent): Promise<Response> {
  if (event.url.pathname === '/admin/setup') {
    const data = await (setupLoad as unknown as (e: RequestEvent) => Promise<unknown>)(event);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  }
  if (event.url.pathname === '/admin' && event.request.method === 'POST') {
    const name = event.url.search.replace(/^\?\//, '') as keyof typeof adminActions;
    const action = adminActions[name] as unknown as (e: RequestEvent) => Promise<unknown>;
    const result = (await action(event)) as { status?: number; data?: unknown };
    // An ActionFailure carries its status and data; a success is the returned object.
    const failed = result && typeof result.status === 'number' && 'data' in result;
    return new Response(JSON.stringify(failed ? result.data : result), {
      status: failed ? result.status : 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const base = event.url.pathname.replace(/\/[^/]+$/, '');
  const handler =
    handlers[event.url.pathname]?.[event.request.method] ?? handlers[base]?.[event.request.method];
  if (!handler) return new Response('no route', { status: 404 });
  return handler(event);
}

let database: Database;
let harness: Harness;
const hub = recordingHub();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  await database.db.insert(invites).values({
    id: '01900000-0000-7000-8000-0000000000c1',
    email: PEOPLE.active.email,
    invitedBy: PEOPLE.admin.id,
    status: 'accepted',
  });
  harness = await createHarness(database, { resolve: route, realtime: hub });
});

const json = { origin: ORIGIN, 'content-type': 'application/json' };

async function send(
  as: string,
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
) {
  return harness.send(path, {
    method,
    headers: { ...(await harness.as(as)), ...(method === 'GET' ? {} : json) },
    body: body === undefined ? null : JSON.stringify(body),
    ...(params ? { params } : {}),
  });
}

async function errorCode(response: Response) {
  return errorBodySchema.parse(await response.json()).error.code;
}

describe('/admin form actions', () => {
  async function post(as: string, action: string, fields: Record<string, string>) {
    const response = await harness.send(`/admin?/${action}`, {
      method: 'POST',
      headers: {
        ...(await harness.as(as)),
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('AC-NAV-02 refuses each action to a member and changes nothing', async () => {
    const state = () =>
      database.db.select({ id: users.id, status: users.status, role: users.role }).from(users);
    const before = await state();
    for (const [action, fields] of [
      ['invite', { email: 'form.member@example.test', displayName: 'Form' }],
      ['revoke', { id: '01900000-0000-7000-8000-0000000000a2' }],
      ['member', { userId: PEOPLE.admin.id, status: 'suspended' }],
      ['member', { userId: PEOPLE.active.id, role: 'admin' }],
    ] as const) {
      const result = await post(PEOPLE.active.email, action, fields);
      expect([action, result.status, result.body.action]).toEqual([action, 403, action]);
    }
    expect(await state()).toEqual(before);
    expect(
      await database.db.select().from(invites).where(eq(invites.email, 'form.member@example.test')),
    ).toEqual([]);
  });

  it('invites, refuses an invalid form, revokes, suspends, reactivates and changes a role', async () => {
    const created = await post(PEOPLE.admin.email, 'invite', {
      email: 'form.friend@example.test',
      displayName: 'Form Friend',
      role: 'admin',
    });
    expect(created).toEqual({ status: 200, body: { action: 'invite', done: 'created' } });
    const [invite] = await database.db
      .select()
      .from(invites)
      .where(eq(invites.email, 'form.friend@example.test'));
    expect(invite?.role).toBe('admin');

    const invalid = await post(PEOPLE.admin.email, 'invite', { email: 'nope', displayName: '' });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.fields as object).sort()).toEqual(['displayName', 'email']);

    expect(await post(PEOPLE.admin.email, 'revoke', { id: invite!.id })).toEqual({
      status: 200,
      body: { action: 'revoke', done: 'revoked' },
    });

    const member = (fields: Record<string, string>) =>
      post(PEOPLE.admin.email, 'member', { userId: PEOPLE.active.id, ...fields });
    expect((await member({ status: 'suspended' })).status).toBe(200);
    expect(
      (await database.db.select().from(users).where(eq(users.id, PEOPLE.active.id)))[0]?.status,
    ).toBe('suspended');
    expect((await member({ status: 'active' })).status).toBe(200);
    expect((await member({ role: 'admin' })).status).toBe(200);
    expect(
      (await database.db.select().from(users).where(eq(users.id, PEOPLE.active.id)))[0],
    ).toMatchObject({ status: 'active', role: 'admin' });
    expect((await member({ role: 'member' })).status).toBe(200);

    // R-NAV-06 through the form: the sole admin cannot suspend themselves.
    const self = await post(PEOPLE.admin.email, 'member', {
      userId: PEOPLE.admin.id,
      status: 'suspended',
    });
    expect(self.status).toBe(409);
  });
});

describe('admin invites API (§11.2)', () => {
  it('AC-NAV-02 refuses every invite and member action to a member, through the API', async () => {
    const calls: [string, string, unknown?, Record<string, string>?][] = [
      ['GET', '/api/v1/admin/invites'],
      ['POST', '/api/v1/admin/invites', { email: 'x@example.test', displayName: 'X' }],
      ['DELETE', '/api/v1/admin/invites', { id: '01900000-0000-7000-8000-0000000000a2' }],
      [
        'PATCH',
        `/api/v1/admin/members/${PEOPLE.admin.id}`,
        { status: 'suspended' },
        { id: PEOPLE.admin.id },
      ],
      [
        'PATCH',
        `/api/v1/admin/members/${PEOPLE.active.id}`,
        { role: 'admin' },
        { id: PEOPLE.active.id },
      ],
    ];
    for (const [method, path, body, params] of calls) {
      const response = await send(PEOPLE.active.email, method, path, body, params);
      expect([method, path, response.status]).toEqual([method, path, 403]);
      expect(await errorCode(response)).toBe('forbidden');
    }
    const [admin] = await database.db.select().from(users).where(eq(users.id, PEOPLE.admin.id));
    expect(admin).toMatchObject({ status: 'active', role: 'admin' });
    expect(
      await database.db.select().from(invites).where(eq(invites.email, 'x@example.test')),
    ).toEqual([]);
  });

  it('invites, answers a duplicate with the same invite, lists it with seats, then revokes it', async () => {
    const body = { email: 'Invited.Here@Example.test', displayName: 'Invited Here' };
    const created = await send(PEOPLE.admin.email, 'POST', '/api/v1/admin/invites', body);
    expect(created.status).toBe(201);
    const { inviteId } = (await created.json()) as { inviteId: string };
    const again = await send(PEOPLE.admin.email, 'POST', '/api/v1/admin/invites', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ inviteId, created: false });

    const list = inviteListSchema.parse(
      await (await send(PEOPLE.admin.email, 'GET', '/api/v1/admin/invites')).json(),
    );
    expect(list.items.find((item) => item.id === inviteId)).toMatchObject({
      email: 'invited.here@example.test',
      status: 'pending',
      userStatus: 'invited',
      accessSyncedAt: null,
    });
    expect(list.seats).toEqual({ used: 3, warnAt: 45, limit: 50 });

    const revoked = await send(PEOPLE.admin.email, 'DELETE', '/api/v1/admin/invites', {
      id: inviteId,
    });
    expect(revoked.status).toBe(200);
    const [row] = await database.db.select().from(invites).where(eq(invites.id, inviteId));
    expect(row?.status).toBe('revoked');
  });

  it('R-AUTH-10 a renewed invite no longer claims to be in the Access policy', async () => {
    const body = { email: 'renewed.here@example.test', displayName: 'Renewed Here' };
    const created = await send(PEOPLE.admin.email, 'POST', '/api/v1/admin/invites', body);
    const { inviteId } = (await created.json()) as { inviteId: string };
    // The CLI stamped the sync; then the invite was revoked (the CLI clears it on remove too).
    await database.db.update(invites).set({ accessSyncedAt: 123 }).where(eq(invites.id, inviteId));
    await send(PEOPLE.admin.email, 'DELETE', '/api/v1/admin/invites', { id: inviteId });
    const renewed = await send(PEOPLE.admin.email, 'POST', '/api/v1/admin/invites', body);
    expect(renewed.status).toBe(201);
    const [row] = await database.db.select().from(invites).where(eq(invites.id, inviteId));
    expect(row).toMatchObject({ status: 'pending', accessSyncedAt: null });
  });

  it('refuses an invalid invite with validation fields', async () => {
    const response = await send(PEOPLE.admin.email, 'POST', '/api/v1/admin/invites', {
      email: 'not-an-email',
      displayName: ' ',
    });
    expect(response.status).toBe(400);
    const body = errorBodySchema.parse(await response.json());
    expect(Object.keys(body.error.fields ?? {}).sort()).toEqual(['displayName', 'email']);
  });

  it('suspends with a disconnect, reactivates, and refuses to suspend the last admin', async () => {
    const path = `/api/v1/admin/members/${PEOPLE.active.id}`;
    const params = { id: PEOPLE.active.id };
    hub.disconnected.splice(0);
    const suspended = await send(
      PEOPLE.admin.email,
      'PATCH',
      path,
      { status: 'suspended' },
      params,
    );
    expect(suspended.status).toBe(200);
    expect(hub.disconnected).toEqual([PEOPLE.active.id]);
    // R-NAV-04: the next request of the suspended member is denied at once.
    expect((await send(PEOPLE.active.email, 'GET', '/api/v1/admin/invites')).status).toBe(403);
    const back = await send(PEOPLE.admin.email, 'PATCH', path, { status: 'active' }, params);
    expect(back.status).toBe(200);

    const self = await send(
      PEOPLE.admin.email,
      'PATCH',
      `/api/v1/admin/members/${PEOPLE.admin.id}`,
      { status: 'suspended' },
      { id: PEOPLE.admin.id },
    );
    expect(self.status).toBe(409);
    expect(await errorCode(self)).toBe('conflict');
  });

  it('R-AUTH-08 / R-DB-07 keyset-pages past 50 invites when accepted and revoked rows exist', async () => {
    const longPrefix = `paged.${'a'.repeat(160)}`;
    for (let start = 0; start < 60; start += 15) {
      await database.db.insert(invites).values(
        Array.from({ length: 15 }, (_, index) => {
          const i = start + index;
          return {
            id: `01900000-0000-7000-8000-00000000b${String(i).padStart(3, '0')}`,
            email: `${longPrefix}.${String(i).padStart(3, '0')}@example.test`,
            invitedBy: PEOPLE.admin.id,
            role: 'member' as const,
            status: i < 40 ? ('revoked' as const) : ('pending' as const),
          };
        }),
      );
    }
    const items: {
      email: string;
      status: string;
      userStatus: string | null;
      displayName: string | null;
    }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await send(
        PEOPLE.admin.email,
        'GET',
        `/api/v1/admin/invites${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: {
          email: string;
          status: string;
          userStatus: string | null;
          displayName: string | null;
        }[];
        nextCursor?: string | null;
      };
      items.push(...body.items);
      cursor = body.nextCursor ?? null;
      pages += 1;
    } while (cursor);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(items.filter((item) => item.email.startsWith('paged.'))).toHaveLength(60);
    // R-AUTH-08: a revoked invite whose user row was kept still carries its user columns.
    expect(items.find((item) => item.email === PEOPLE.revoked.email)).toMatchObject({
      status: 'revoked',
      userStatus: 'invited',
      displayName: 'Revoked Invite',
    });
    await database.db.delete(invites).where(sql`${invites.email} like 'paged.%@example.test'`);
  });

  it('AC-AUTH-09 invite changes past 30 per hour per admin answer 429 with Retry-After', async () => {
    // Earlier tests in this file already used some of the admin's hour.
    let response: Response | undefined;
    for (let index = 0; index < 31; index += 1) {
      response = await send(PEOPLE.admin.email, 'POST', '/api/v1/admin/invites', {
        email: `burst.${index}@example.test`,
        displayName: `Burst ${index}`,
      });
      if (response.status === 429) break;
    }
    expect(response?.status).toBe(429);
    expect(await errorCode(response!)).toBe('rate_limited');
    expect(Number(response!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('AC-AUTH-09 profile writes past 20 per hour are refused (the PATCH /api/v1/me slice wires the route)', async () => {
    const now = Date.now();
    for (let index = 0; index < 20; index += 1) {
      expect(await takeRateLimit(database, 'profile', PEOPLE.active.id, now)).toEqual({ ok: true });
    }
    expect(await takeRateLimit(database, 'profile', PEOPLE.active.id, now)).toEqual({
      ok: false,
      retryAfterSeconds: 3600,
    });
  });
});

describe('setup lock on D1 (R-AUTH-12)', () => {
  it('AC-AUTH-06 no setup_state row is locked: APIs answer 423 and pages /locked', async () => {
    await database.db.delete(siteSettings).where(eq(siteSettings.key, 'setup_state'));
    const api = await send(PEOPLE.admin.email, 'GET', '/api/v1/admin/invites');
    expect(api.status).toBe(423);
    const page = await harness.send('/members', { headers: await harness.as(PEOPLE.active.email) });
    expect([page.status, page.headers.get('location')]).toEqual([303, '/locked']);
    for (const response of [api, page]) {
      const text = await response.text();
      for (const person of Object.values(PEOPLE)) expect(text).not.toContain(person.email);
    }
  });

  it('AC-AUTH-06 the bootstrap admin sees only the lock state on /admin/setup', async () => {
    // The bootstrap admin's invite names themselves as the inviter (R-OPS-04).
    await database.db.insert(invites).values({
      id: '01900000-0000-7000-8000-0000000000c2',
      email: PEOPLE.admin.email,
      invitedBy: PEOPLE.admin.id,
      role: 'admin',
      status: 'accepted',
    });
    const setup = await harness.send('/admin/setup', {
      headers: await harness.as(PEOPLE.admin.email),
    });
    expect(setup.status).toBe(200);
    expect(await setup.json()).toEqual({ unlocked: false, secondAdmin: false });
    const api = await send(PEOPLE.admin.email, 'GET', '/api/v1/admin/invites');
    expect(api.status).toBe(423);
    await setSetupState(database, 'unlocked');
  });
});
