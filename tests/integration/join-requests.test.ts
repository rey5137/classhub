import { applyD1Migrations, env } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { eq, like } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import {
  auditEvents,
  invites,
  joinRequests,
  rateEvents,
  schemaMeta,
  siteSettings,
  users,
} from '../../src/lib/server/db/schema';
import type { Member } from '../../src/lib/server/auth/membership';
import type { Database, DatabaseBatch } from '../../src/lib/server/ports/database';
import { defaultSettings } from '../../src/lib/server/services/settings';
import { load as layoutLoad } from '../../src/routes/+layout.server';
import { takeRateLimit } from '../../src/lib/server/services/rate-limit';
import { JobRunner } from '../../src/lib/server/services/job-runner';
import { actions as adminActions } from '../../src/routes/admin/+page.server';
import * as listApi from '../../src/routes/api/v1/admin/join-requests/+server';
import * as itemApi from '../../src/routes/api/v1/admin/join-requests/[id]/+server';
import {
  GOOD_TOKEN,
  joinForm,
  pageState,
  renderJoin,
  setJoin,
  storedRequests,
  stubTurnstile,
} from '../fixtures/join-route';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// §6.8 through the real pipeline, the real `/join` and admin handlers, on D1.

const DAY = 86_400_000;
type Handler = (event: RequestEvent) => Response | Promise<Response>;

async function route(event: RequestEvent): Promise<Response> {
  const path = event.url.pathname;
  if (path === '/join') return renderJoin(event);
  if (path === '/admin' && event.request.method === 'POST') {
    const name = event.url.search.replace(/^\?\//, '') as keyof typeof adminActions;
    const action = adminActions[name] as unknown as (e: RequestEvent) => Promise<unknown>;
    const result = (await action(event)) as { status?: number; data?: unknown };
    const failed = result && typeof result.status === 'number' && 'data' in result;
    return new Response(JSON.stringify(failed ? result.data : result), {
      status: failed ? result.status : 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const api = (path === '/api/v1/admin/join-requests' ? listApi : itemApi) as unknown as Record<
    string,
    Handler
  >;
  const handler = path.startsWith('/api/v1/admin/join-requests') && api[event.request.method];
  if (!handler) return new Response(`<p>${path}</p>`, { headers: { 'content-type': 'text/html' } });
  return handler(event);
}

/** Records every batch's SQL, to show what shares a batch (R-AUTH-30). */
function recording(database: Database) {
  const batches: string[][] = [];
  /** Runs once, just before the next batch that writes an invite (a concurrent change). */
  const hooks: { beforeInvite: (() => Promise<void>) | null } = { beforeInvite: null };
  const wrapped: Database = {
    ...database,
    db: database.db,
    batch: async (items: DatabaseBatch) => {
      const sql = items.map(
        (item) => (item as unknown as { toSQL(): { sql: string } }).toSQL().sql,
      );
      batches.push(sql);
      const hook = hooks.beforeInvite;
      if (hook && sql.some((s) => /"invites"/i.test(s) && /^(insert|update)/i.test(s))) {
        hooks.beforeInvite = null;
        await hook();
      }
      return database.batch(items);
    },
  };
  return { wrapped, batches, hooks };
}

/** One row per statement: D1 binds at most 100 parameters. */
async function insertRows<T extends typeof joinRequests | typeof invites>(
  table: T,
  rows: T['$inferInsert'][],
) {
  for (const row of rows) await raw.db.insert(table).values(row as never);
}

let raw: Database;
let database: Database;
let batches: string[][];
let hooks: ReturnType<typeof recording>['hooks'];
let harness: Harness;
let address = 0;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  raw = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  ({ wrapped: database, batches, hooks } = recording(raw));
  await seedMembership(raw);
  harness = await createHarness(database, { resolve: route, turnstile: stubTurnstile });
});

beforeEach(async () => {
  await raw.db.delete(joinRequests);
  await raw.db.delete(rateEvents);
  await raw.db.delete(auditEvents);
  await raw.db.delete(invites).where(like(invites.email, '%@join.example.test'));
  await raw.db.delete(users).where(like(users.authEmail, '%@join.example.test'));
  await setJoin(raw, true);
  batches.length = 0;
  hooks.beforeInvite = null;
});

function submit(
  fields: Partial<Record<'name' | 'email' | 'note' | 'cf-turnstile-response', string>>,
  clientAddress = `198.51.100.${(address += 1) % 250}`,
) {
  return harness.send('/join', {
    ...joinForm({
      name: 'Synthetic Classmate',
      note: 'Class of 2012',
      'cf-turnstile-response': GOOD_TOKEN,
      ...fields,
    } as Record<string, string>),
    clientAddress,
  });
}

const email = (n: number | string) => `person.${n}@join.example.test`;

async function send(as: string, method: string, path: string, params?: Record<string, string>) {
  return harness.send(path, {
    method,
    headers: { ...(await harness.as(as)), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(params ? { params } : {}),
  });
}

async function errorCode(response: Response) {
  return errorBodySchema.parse(await response.json()).error.code;
}

describe('the /join gate (R-AUTH-27)', () => {
  it('AC-AUTH-19 with join off, GET and POST /join answer 404 and reach nothing', async () => {
    await setJoin(raw, false);
    const page = await harness.send('/join');
    const post = await submit({ email: email('off') });
    expect([page.status, post.status]).toEqual([404, 404]);
    expect(await errorCode(post)).toBe('not_found');
    expect(harness.resolved.splice(0)).toEqual([]);
    expect(await storedRequests(raw)).toEqual([]);
    // The default, with no toggles row at all, is off too.
    await raw.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
    expect((await harness.send('/join')).status).toBe(404);
  });

  it('AC-AUTH-19 with join on, /join shows the site name and the form, and no member data even with a member JWT', async () => {
    await raw.db
      .insert(siteSettings)
      .values({ key: 'logoMediaId', valueJson: JSON.stringify(crypto.randomUUID()) })
      .onConflictDoNothing();
    const response = await harness.send('/join', {
      headers: await harness.as(PEOPLE.admin.email),
    });
    expect(response.status).toBe(200);
    const page = await pageState(response.clone());
    expect(page.member).toBeNull();
    expect(page.data).toEqual({
      closed: false,
      turnstile: {
        siteKey: stubTurnstile.siteKey,
        script: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
      },
    });
    expect(page.layout).toMatchObject({
      site: { name: expect.any(String), logoMediaId: null },
      nav: [],
      storageWarning: false,
    });
    const text = await response.text();
    for (const person of Object.values(PEOPLE)) expect(text).not.toContain(person.email);
    expect(text).not.toMatch(/Class Admin|Active Member|\/api\/v1\/media/);
    // No identity was read: the visit did not even touch the member's last-seen time.
    const [admin] = await raw.db
      .select({ lastSeenAt: users.lastSeenAt })
      .from(users)
      .where(eq(users.id, PEOPLE.admin.id));
    expect(admin?.lastSeenAt ?? null).toBeNull();
  });

  it('AC-AUTH-19 only /join is a public page; a member page with every feature off keeps its account links', async () => {
    const off = {
      ...defaultSettings,
      features: { memories: false, discussions: false, chat: false, join: true },
    };
    const layout = (routeId: string, member: Member | null) =>
      layoutLoad({
        locals: { member, settings: off, locale: 'vi', theme: 'yearbook', mode: 'light' },
        route: { id: routeId },
      } as unknown as Parameters<typeof layoutLoad>[0]) as Promise<{
        publicPage: boolean;
        nav: unknown[];
      }>;
    const admin = { id: PEOPLE.admin.id, role: 'admin' } as Member;
    for (const id of ['/', '/members', '/admin', '/profile', '/denied']) {
      expect([id, (await layout(id, admin)).publicPage]).toEqual([id, false]);
    }
    // AppShell gates the account menu, nav and brand link on this flag, not on the nav.
    expect(await layout('/join', null)).toMatchObject({ publicPage: true, nav: [] });
  });

  it('AC-AUTH-19 every other path and method still requires Access', async () => {
    harness.resolved.length = 0;
    const cases: [string, string, number][] = [
      ['GET', '/join/x', 303],
      ['GET', '/joinx', 303],
      ['PUT', '/join', 403],
      ['DELETE', '/join', 403],
      ['GET', '/api/v1/admin/join-requests', 403],
      ['POST', '/api/v1/admin/join-requests/x', 403],
      ['DELETE', '/api/v1/admin/join-requests/x', 403],
    ];
    for (const [method, path, status] of cases) {
      const response = await harness.send(path, {
        method,
        routeId: null,
        headers: method === 'GET' ? {} : { origin: ORIGIN },
      });
      expect([method, path, response.status]).toEqual([method, path, status]);
    }
    expect(harness.resolved.splice(0)).toEqual([]);
  });

  it('AC-AUTH-19 a cross-origin POST /join is refused before the form', async () => {
    const response = await harness.send('/join', {
      ...joinForm({ name: 'X', email: email('x'), 'cf-turnstile-response': GOOD_TOKEN }),
      headers: { origin: 'https://evil.example.test' },
    });
    expect(response.status).toBe(403);
    expect(await storedRequests(raw)).toEqual([]);
  });

  it('AC-AUTH-19 only /join, and only while on, admits Turnstile in its CSP', async () => {
    const csp = async (path: string, headers: Record<string, string> = {}) =>
      (await harness.send(path, { headers })).headers.get('content-security-policy') ?? '';
    const open = await csp('/join');
    expect(open).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(open).toMatch(/frame-src https:\/\/challenges\.cloudflare\.com/);
    expect(open).toMatch(/default-src 'self'/);
    const member = await harness.as(PEOPLE.active.email);
    for (const other of [
      await csp('/members', member),
      await csp('/admin', await harness.as(PEOPLE.admin.email)),
      await csp('/denied'),
      await csp('/join/x'),
    ]) {
      expect(other).not.toContain('challenges.cloudflare.com');
      expect(other).not.toContain('frame-src');
    }
    await setJoin(raw, false);
    expect(await csp('/join')).not.toContain('challenges.cloudflare.com');
  });
});

describe('submissions (R-AUTH-28, R-AUTH-29)', () => {
  it('stores a new request with a salted IP hash, normalised email and no raw address', async () => {
    const response = await submit({ email: `  ${email('New').toUpperCase()} ` }, '203.0.113.99');
    expect(response.status).toBe(200);
    expect((await pageState(response)).form).toEqual({ sent: true });
    const [row] = await storedRequests(raw);
    expect(row).toMatchObject({
      email: email('new'),
      name: 'Synthetic Classmate',
      note: 'Class of 2012',
    });
    expect(row?.ipHash).toMatch(/^[0-9a-f]{16}$/);
    const stored = JSON.stringify(await raw.db.select().from(rateEvents));
    expect(`${stored}${JSON.stringify(row)}`).not.toContain('203.0.113.99');
  });

  it('AC-AUTH-17 without a valid Turnstile token nothing is stored and the page asks to try again', async () => {
    for (const token of [undefined, '', 'forged-token']) {
      const fields = { email: email('token') } as Record<string, string>;
      if (token !== undefined) fields['cf-turnstile-response'] = token;
      const response = await harness.send('/join', {
        ...joinForm({ name: 'Synthetic', ...fields }),
        clientAddress: '198.51.100.200',
      });
      expect(response.status).toBe(400);
      // A token not issued yet reads as a failed check, with its message (not a silent form).
      expect([token, (await pageState(response)).form]).toEqual([
        token,
        expect.objectContaining({ retry: 'verify' }),
      ]);
    }
    const page = await pageState(
      await submit({ email: email('token'), 'cf-turnstile-response': 'bad' }),
    );
    expect(page.form).toMatchObject({ retry: 'verify' });
    expect(await storedRequests(raw)).toEqual([]);
  });

  it('AC-AUTH-17 without Turnstile keys configured nothing is stored', async () => {
    const bare = await createHarness(database, { resolve: route });
    const response = await bare.send(
      '/join',
      joinForm({
        name: 'Synthetic',
        email: email('nokeys'),
        'cf-turnstile-response': GOOD_TOKEN,
      }),
    );
    expect(response.status).toBe(400);
    expect(await storedRequests(raw)).toEqual([]);
  });

  it('a production build without LOG_HASH_SALT refuses every request with one valueless config line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const unsalted = await createHarness(database, {
        resolve: route,
        turnstile: stubTurnstile,
        production: true,
      });
      const form = joinForm({
        name: 'Synthetic',
        email: email('nosalt'),
        'cf-turnstile-response': GOOD_TOKEN,
      });
      for (const n of [1, 2]) {
        const response = await unsalted.send('/join', { ...form, clientAddress: `192.0.2.${n}` });
        expect(response.status).toBe(503);
        expect((await pageState(response)).form).toMatchObject({ retry: 'later' });
      }
      expect(await storedRequests(raw)).toEqual([]);
      expect(await raw.db.select().from(rateEvents)).toEqual([]);
      const lines = warn.mock.calls
        .map(([line]) => String(line))
        .filter((l) => l.includes('/join'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        level: 'warn',
        config: 'LOG_HASH_SALT is not set: /join refuses requests',
      });

      // With the secret set, the same production build takes requests.
      const salted = await createHarness(database, {
        resolve: route,
        turnstile: stubTurnstile,
        production: true,
        logHashSalt: 'production-salt',
      });
      expect((await salted.send('/join', { ...form, clientAddress: '192.0.2.3' })).status).toBe(
        200,
      );
      expect(await storedRequests(raw)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a bad name, email or note field by field, storing nothing', async () => {
    const response = await submit({ name: '', email: 'not-an-email', note: 'x'.repeat(301) });
    expect(response.status).toBe(400);
    expect(Object.keys((await pageState(response)).form?.fields as object).sort()).toEqual([
      'email',
      'name',
      'note',
    ]);
    expect(await storedRequests(raw)).toEqual([]);
  });

  it('AC-AUTH-17 over 3 submissions from one IP in an hour, nothing is stored', async () => {
    for (const n of [1, 2, 3]) {
      expect((await submit({ email: email(`ip${n}`) }, '192.0.2.10')).status).toBe(200);
    }
    const over = await submit({ email: email('ip4') }, '192.0.2.10');
    expect(over.status).toBe(429);
    expect((await pageState(over)).form).toMatchObject({ retry: 'rate' });
    expect((await storedRequests(raw)).map((row) => row.email)).toEqual([
      email('ip1'),
      email('ip2'),
      email('ip3'),
    ]);
    // Another address is not limited by this one.
    expect((await submit({ email: email('ip5') }, '192.0.2.11')).status).toBe(200);
  });

  it('AC-AUTH-17 over 20 submissions site-wide in an hour, nothing is stored', async () => {
    for (let n = 0; n < 20; n += 1) await takeRateLimit(raw, 'joinSite', 'site');
    const over = await submit({ email: email('site') });
    expect(over.status).toBe(429);
    expect(await storedRequests(raw)).toEqual([]);
  });

  async function seed(count: number, prefix: string, now = Date.now()) {
    if (count === 0) return;
    await insertRows(
      joinRequests,
      Array.from({ length: count }, (_, n) => ({
        id: crypto.randomUUID(),
        email: email(`${prefix}${n}`),
        name: `Seed ${n}`,
        note: '',
        ipHash: 'seed',
        createdAt: now - n,
      })),
    );
  }

  it('AC-AUTH-17 with the queue at join.maxPending, /join shows the closed notice and stores nothing', async () => {
    await seed(19, 'a');
    expect((await pageState(await harness.send('/join'))).data.closed).toBe(false);
    await seed(1, 'b', Date.now() - 1_000);
    const page = await pageState(await harness.send('/join'));
    expect(page.data.closed).toBe(true);
    const post = await submit({ email: email('capped') });
    expect(post.status).toBe(409);
    expect((await pageState(post)).form).toEqual({ closed: true });
    expect(await storedRequests(raw)).toHaveLength(20);
    // A closed queue takes no rate slot either.
    expect(await raw.db.select().from(rateEvents)).toEqual([]);
  });

  it('AC-AUTH-17 with no free seat for another request, /join is closed and stores nothing', async () => {
    // 2 active members + 47 pending invites = 49 seats: one request fills the last.
    await insertRows(
      invites,
      Array.from({ length: 47 }, (_, n) => ({
        id: crypto.randomUUID(),
        email: email(`seat${n}`),
        invitedBy: PEOPLE.admin.id,
        status: 'pending' as const,
        createdAt: Date.now(),
      })),
    );
    expect((await submit({ email: email('lastseat') })).status).toBe(200);
    expect((await pageState(await harness.send('/join'))).data.closed).toBe(true);
    expect((await submit({ email: email('noseat') })).status).toBe(409);
    expect((await storedRequests(raw)).map((row) => row.email)).toEqual([email('lastseat')]);
    const list = await send(PEOPLE.admin.email, 'GET', '/api/v1/admin/join-requests');
    expect(((await list.json()) as { full: boolean }).full).toBe(true);
  });
});

describe('the admin queue (R-AUTH-30)', () => {
  async function request(n: string) {
    expect(
      (await submit({ email: email(n), name: `Requester ${n}`, note: `note ${n}` })).status,
    ).toBe(200);
    const [row] = await raw.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.email, email(n)));
    return row!;
  }

  function contentFree(
    rows: (typeof auditEvents.$inferSelect)[],
    row: { email: string; name: string; note: string },
  ) {
    const text = JSON.stringify(rows);
    expect(text).not.toContain(row.email);
    expect(text).not.toContain(row.name);
    expect(text).not.toContain(row.note);
  }

  it('lists pending requests to admins only, with name, email, note and time', async () => {
    const row = await request('list');
    const list = await send(PEOPLE.admin.email, 'GET', '/api/v1/admin/join-requests');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      items: [
        { id: row.id, name: row.name, email: row.email, note: row.note, createdAt: row.createdAt },
      ],
      full: false,
    });
    const member = await send(PEOPLE.active.email, 'GET', '/api/v1/admin/join-requests');
    expect([member.status, await errorCode(member)]).toEqual([403, 'forbidden']);
    for (const method of ['POST', 'DELETE']) {
      const refused = await send(
        PEOPLE.active.email,
        method,
        `/api/v1/admin/join-requests/${row.id}`,
        {
          id: row.id,
        },
      );
      expect([method, refused.status]).toEqual([method, 403]);
    }
    expect(await storedRequests(raw)).toHaveLength(1);
  });

  it('AC-AUTH-18 approve creates a pending invite and deletes the request in one batch, with a content-free audit row', async () => {
    const row = await request('approve');
    batches.length = 0;
    const response = await send(
      PEOPLE.admin.email,
      'POST',
      `/api/v1/admin/join-requests/${row.id}`,
      { id: row.id },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { inviteId: string; created: boolean };
    expect(body.created).toBe(true);

    const [invite] = await raw.db.select().from(invites).where(eq(invites.email, row.email));
    expect(invite).toMatchObject({ id: body.inviteId, status: 'pending', role: 'member' });
    const [user] = await raw.db.select().from(users).where(eq(users.authEmail, row.email));
    expect(user).toMatchObject({ status: 'invited', displayName: row.name, accessSub: null });
    expect(await storedRequests(raw)).toEqual([]);

    const shared = batches.filter(
      (sql) =>
        sql.some((s) => /insert into "invites"/i.test(s)) &&
        sql.some((s) => /delete from "join_requests"/i.test(s)),
    );
    expect(shared).toHaveLength(1);

    const audit = await raw.db.select().from(auditEvents);
    expect(audit.map((event) => [event.action, event.entityType, event.entityId]).sort()).toEqual(
      [
        ['invite.created', 'invite', body.inviteId],
        ['join.approved', 'join_request', row.id],
      ].sort(),
    );
    contentFree(audit, row);

    // A second approve finds nothing: the request is gone, the invite unchanged.
    const again = await send(PEOPLE.admin.email, 'POST', `/api/v1/admin/join-requests/${row.id}`, {
      id: row.id,
    });
    expect([again.status, await errorCode(again)]).toEqual([404, 'not_found']);
    expect(await raw.db.select().from(invites).where(eq(invites.email, row.email))).toHaveLength(1);
  });

  it('AC-AUTH-18 the approved requester stays denied until their first verified login', async () => {
    const row = await request('login');
    await send(PEOPLE.admin.email, 'POST', `/api/v1/admin/join-requests/${row.id}`, { id: row.id });
    const status = async () =>
      (await raw.db.select().from(users).where(eq(users.authEmail, row.email)))[0]?.status;
    expect(await status()).toBe('invited');
    // A forged email header is no login (AC-AUTH-02).
    const forged = await harness.send('/members', {
      headers: { 'cf-access-authenticated-user-email': row.email },
    });
    expect([forged.status, forged.headers.get('location')]).toEqual([303, '/denied']);
    expect(await status()).toBe('invited');
    const first = await harness.send('/members', { headers: await harness.as(row.email) });
    expect(first.status).toBe(200);
    expect(await status()).toBe('active');
  });

  it('AC-AUTH-18 an approve that finds no free seat keeps the request and creates nothing', async () => {
    const row = await request('noseat');
    await insertRows(
      invites,
      Array.from({ length: 48 }, (_, n) => ({
        id: crypto.randomUUID(),
        email: email(`full${n}`),
        invitedBy: PEOPLE.admin.id,
        status: 'pending' as const,
        createdAt: Date.now(),
      })),
    );
    const response = await send(
      PEOPLE.admin.email,
      'POST',
      `/api/v1/admin/join-requests/${row.id}`,
      {
        id: row.id,
      },
    );
    expect([response.status, await errorCode(response)]).toEqual([409, 'conflict']);
    expect(await storedRequests(raw)).toHaveLength(1);
    expect(await raw.db.select().from(invites).where(eq(invites.email, row.email))).toEqual([]);
    expect(await raw.db.select().from(auditEvents)).toEqual([]);
  });

  it('AC-AUTH-18 an approve racing a reject invites no one', async () => {
    const row = await request('race');
    // Admin B's reject lands between A's read of the request and A's invite batch.
    hooks.beforeInvite = async () => {
      await raw.db.delete(joinRequests).where(eq(joinRequests.id, row.id));
    };
    const response = await send(
      PEOPLE.admin.email,
      'POST',
      `/api/v1/admin/join-requests/${row.id}`,
      { id: row.id },
    );
    expect([response.status, await errorCode(response)]).toEqual([404, 'not_found']);
    expect(hooks.beforeInvite).toBeNull();
    expect(await raw.db.select().from(invites).where(eq(invites.email, row.email))).toEqual([]);
    expect(await raw.db.select().from(users).where(eq(users.authEmail, row.email))).toEqual([]);
    expect(await raw.db.select().from(auditEvents)).toEqual([]);
  });

  it('AC-AUTH-18 a stale request never re-invites a suspended or active account; the request is kept', async () => {
    for (const status of ['suspended', 'active'] as const) {
      const row = await request(`settled-${status}`);
      // Invited directly, joined, and (for one) suspended since the request came in.
      const userId = crypto.randomUUID();
      await raw.db.insert(users).values({
        id: userId,
        authEmail: row.email,
        displayName: 'Settled',
        displayNameNorm: 'settled',
        role: 'member',
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const response = await send(
        PEOPLE.admin.email,
        'POST',
        `/api/v1/admin/join-requests/${row.id}`,
        { id: row.id },
      );
      expect([status, response.status, await errorCode(response)]).toEqual([
        status,
        409,
        'conflict',
      ]);
      const [user] = await raw.db.select().from(users).where(eq(users.id, userId));
      expect(user?.status).toBe(status);
      expect(await raw.db.select().from(invites).where(eq(invites.email, row.email))).toEqual([]);
      expect(
        await raw.db.select().from(joinRequests).where(eq(joinRequests.id, row.id)),
      ).toHaveLength(1);
    }
    expect(await raw.db.select().from(auditEvents)).toEqual([]);
  });

  it('AC-AUTH-18 an account suspended between the check and the batch is not re-invited', async () => {
    const row = await request('settled-race');
    const userId = crypto.randomUUID();
    hooks.beforeInvite = async () => {
      await raw.db.insert(users).values({
        id: userId,
        authEmail: row.email,
        displayName: 'Settled',
        displayNameNorm: 'settled',
        role: 'member',
        status: 'suspended',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    };
    const response = await send(
      PEOPLE.admin.email,
      'POST',
      `/api/v1/admin/join-requests/${row.id}`,
      { id: row.id },
    );
    expect([response.status, await errorCode(response)]).toEqual([409, 'conflict']);
    const [user] = await raw.db.select().from(users).where(eq(users.id, userId));
    expect(user?.status).toBe('suspended');
    expect(await raw.db.select().from(invites).where(eq(invites.email, row.email))).toEqual([]);
    expect(await storedRequests(raw)).toHaveLength(1);
  });

  it('AC-AUTH-18 approving an email invited meanwhile keeps that invite and deletes the request', async () => {
    const row = await request('meanwhile');
    const invited = await harness.send('/admin?/invite', {
      method: 'POST',
      headers: {
        ...(await harness.as(PEOPLE.admin.email)),
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: row.email, displayName: 'Invited Directly' }).toString(),
    });
    expect(invited.status).toBe(200);
    const response = await send(
      PEOPLE.admin.email,
      'POST',
      `/api/v1/admin/join-requests/${row.id}`,
      {
        id: row.id,
      },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { created: boolean }).created).toBe(false);
    expect(await storedRequests(raw)).toEqual([]);
    const actions = (await raw.db.select().from(auditEvents)).map((event) => event.action).sort();
    expect(actions).toEqual(['invite.created', 'join.approved']);
  });

  it('AC-AUTH-18 reject deletes the request at once with a content-free audit row; a repeat is 404', async () => {
    const row = await request('reject');
    const response = await send(
      PEOPLE.admin.email,
      'DELETE',
      `/api/v1/admin/join-requests/${row.id}`,
      { id: row.id },
    );
    expect(response.status).toBe(200);
    expect(await storedRequests(raw)).toEqual([]);
    expect(await raw.db.select().from(invites).where(eq(invites.email, row.email))).toEqual([]);
    const audit = await raw.db.select().from(auditEvents);
    expect(audit.map((event) => [event.action, event.entityType, event.entityId])).toEqual([
      ['join.rejected', 'join_request', row.id],
    ]);
    contentFree(audit, row);
    const again = await send(
      PEOPLE.admin.email,
      'DELETE',
      `/api/v1/admin/join-requests/${row.id}`,
      {
        id: row.id,
      },
    );
    expect([again.status, await errorCode(again)]).toEqual([404, 'not_found']);
    expect(await raw.db.select().from(auditEvents)).toHaveLength(1);
  });

  it('AC-AUTH-18 the /admin form actions approve and reject the same way', async () => {
    const approve = await request('formapprove');
    const reject = await request('formreject');
    const post = async (action: string, id: string) => {
      const response = await harness.send(`/admin?/${action}`, {
        method: 'POST',
        headers: {
          ...(await harness.as(PEOPLE.admin.email)),
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ id }).toString(),
      });
      return { status: response.status, body: await response.json() };
    };
    expect(await post('joinApprove', approve.id)).toEqual({
      status: 200,
      body: { action: 'joinApprove', done: 'joinApproved' },
    });
    expect(await post('joinReject', reject.id)).toEqual({
      status: 200,
      body: { action: 'joinReject', done: 'joinRejected' },
    });
    expect(await storedRequests(raw)).toEqual([]);
    expect(
      await raw.db.select().from(invites).where(eq(invites.email, approve.email)),
    ).toHaveLength(1);
    expect((await post('joinReject', reject.id)).status).toBe(404);
  });
});

describe('housekeeping (R-AUTH-29)', () => {
  const storage = {
    list: async () => ({ objects: [], cursor: null }),
    delete: async () => {},
  };

  it('deletes requests older than 30 days, at most 20 per run, and keeps newer ones', async () => {
    const now = Date.now();
    const rows = [
      ...Array.from({ length: 22 }, (_, n) => ({ n: `old${n}`, at: now - 30 * DAY - 1_000 - n })),
      { n: 'recent', at: now - 29 * DAY },
    ];
    await insertRows(
      joinRequests,
      rows.map(({ n, at }) => ({
        id: crypto.randomUUID(),
        email: email(n),
        name: n,
        note: '',
        ipHash: 'seed',
        createdAt: at,
      })),
    );
    // Free the hourly slot the requests above may have claimed.
    await raw.db
      .update(schemaMeta)
      .set({ value: '0' })
      .where(eq(schemaMeta.key, 'housekeeping_last_run_at'));
    await new JobRunner({ database: raw, storage } as never).trigger(now);
    const left = (await storedRequests(raw)).map((row) => row.name);
    expect(left).toHaveLength(3);
    expect(left).toContain('recent');
    // The oldest go first.
    expect(left.sort()).toEqual(['old0', 'old1', 'recent']);
  });
});
