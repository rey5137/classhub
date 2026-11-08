import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { t } from '../../src/lib/i18n';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { apiError } from '../../src/lib/server/errors';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import { seedDemo } from '../../src/lib/server/db/seed-demo';
import { media, posts, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import type { RoomSocket, SocketAttachment } from '../../src/lib/server/services/chat-room';
import { ChatRoomCore } from '../../src/lib/server/services/chat-room';
import { normalizeName } from '../../src/lib/shared/normalize';
import { resolveAppRoute } from '../fixtures/app-routes';
import { writeFailingD1 } from '../fixtures/d1-instrument';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';
import { budgets } from '../fixtures/row-budgets';

// AC-BUD-04, R-BUD-05, R-BUD-06: with every D1 write failing, reads still render and
// content writes refuse with `unavailable`; identity writes fail closed, never open.

const MEMBER = 'mai.nguyen@example.com';
const ADMIN = 'admin@example.com';
const ids: Record<string, string> = {};

let harness: Harness;
let database: Database;
let healthy: Database;

function path(template: string): string {
  return template.replace(/:([a-z]+)/g, (_, token: string) => ids[token]!);
}

async function send(
  as: string,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<Response> {
  return harness.send(requestPath, {
    method,
    headers: {
      ...(await harness.as(as)),
      ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  return errorBodySchema.parse(await response.json()).error;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const storage = new R2ObjectStorage(
    env.MEDIA as unknown as ConstructorParameters<typeof R2ObjectStorage>[0],
  );
  healthy = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedDemo(healthy, storage);

  const [member] = await healthy.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authEmail, MEMBER))
    .limit(1);
  const [admin] = await healthy.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authEmail, ADMIN))
    .limit(1);
  const [post] = await healthy.db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.isLocked, false))
    .limit(1);
  const [photo] = await healthy.db.select({ id: media.id }).from(media).limit(1);
  Object.assign(ids, {
    member: member?.id,
    admin: admin?.id,
    post: post?.id,
    media: photo?.id,
    info: 'reunion',
  });

  // R-AUTH-25: these members have signed in before, so the identity path makes no
  // write; the write failure must not turn a read into a denial or a 500.
  for (const email of [MEMBER, ADMIN]) {
    await healthy.db
      .update(users)
      .set({ accessSub: `sub:${email}` })
      .where(eq(users.authEmail, email));
  }

  database = createD1Database(
    writeFailingD1(env.DB as unknown as Parameters<typeof writeFailingD1>[0]),
  );
  harness = await createHarness(database, {
    resolve: resolveAppRoute,
    appearance: true,
    storage,
  });
});

describe('AC-BUD-04 reads with D1 writes failing', () => {
  it('every budgeted page and GET route still answers as it does with writes', async () => {
    for (const entry of budgets) {
      const response = await send(entry.as === 'admin' ? ADMIN : MEMBER, 'GET', path(entry.path));
      await response.body?.cancel();
      const expected = entry.route === 'GET /denied' ? 403 : 200;
      expect([entry.route, response.status], `${entry.route} with writes failing`).toEqual([
        entry.route,
        expected,
      ]);
    }
  });
});

describe('AC-BUD-04 content writes with D1 writes failing', () => {
  it.each([
    ['new post', 'POST', '/api/v1/posts', { title: 'Synthetic title', body: 'Synthetic body' }],
    ['new comment', 'POST', '/api/v1/posts/:post/comments', { body: 'Synthetic comment' }],
    ['profile save', 'PATCH', '/api/v1/me', { bio: 'Synthetic bio' }],
    [
      'upload init',
      'POST',
      '/api/v1/media/reservations',
      {
        purpose: 'photo',
        imageBytes: 1024,
        thumbBytes: 128,
        sha256: 'a'.repeat(64),
        thumbSha256: 'b'.repeat(64),
        mimeType: 'image/jpeg',
        width: 1024,
        height: 768,
      },
    ],
  ] as const)('%s answers unavailable, not 500', async (name, method, requestPath, body) => {
    const response = await send(MEMBER, method, path(requestPath), body);
    expect([name, response.status]).toEqual([name, 503]);
    const error = await errorOf(response);
    expect([name, error.code]).toEqual([name, 'unavailable']);
    expect(
      [t('en', 'error.unavailable'), t('vi', 'error.unavailable')],
      `${name} message`,
    ).toContain(error.message);
  });

  it('form action POST /discussions?/create answers unavailable, not 500', async () => {
    const form = new URLSearchParams({ title: 'Synthetic title', body: 'Synthetic body' });
    const response = await harness.send('/discussions?/create', {
      method: 'POST',
      headers: {
        ...(await harness.as(MEMBER)),
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    expect(response.status).toBe(503);
    const error = await errorOf(response);
    expect(error.code).toBe('unavailable');
    expect([t('en', 'error.unavailable'), t('vi', 'error.unavailable')]).toContain(error.message);
  });

  it('enhanced form action (x-sveltekit-action) keeps SvelteKit error shape with 503 so use:enhance shows the error', async () => {
    const form = new URLSearchParams({ title: 'Synthetic title', body: 'Synthetic body' });
    const response = await harness.send('/discussions?/create', {
      method: 'POST',
      headers: {
        ...(await harness.as(MEMBER)),
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        'x-sveltekit-action': 'true',
      },
      body: form.toString(),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      type?: string;
      error?: { message?: string; requestId?: string };
    };
    expect(body.type).toBe('error');
    expect([t('en', 'error.unavailable'), t('vi', 'error.unavailable')]).toContain(
      body.error?.message,
    );
    expect(body.error?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('client-side __data.json load keeps SvelteKit error shape with 503 when D1 fails', async () => {
    const failingLoad = await createHarness(database, {
      appearance: true,
      resolve: async () => {
        const err = new Error('D1_ERROR: D1 DB is overloaded, requests queued for too long');
        err.name = 'D1Error';
        throw err;
      },
    });
    const response = await failingLoad.send('/members/__data.json', {
      isDataRequest: true,
      headers: await failingLoad.as(MEMBER),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      type?: string;
      error?: { message?: string; requestId?: string };
    };
    expect(body.type).toBe('error');
    expect([t('en', 'error.unavailable'), t('vi', 'error.unavailable')]).toContain(
      body.error?.message,
    );
    expect(body.error?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a chat send through the room is not acked and reports not_saved (INV-8)', async () => {
    const frames: unknown[] = [];
    const closed: { code: number; reason: string }[] = [];
    const attachment: SocketAttachment = {
      memberId: ids.member!,
      role: 'member',
      displayName: 'Mai Nguyen',
      connectedAt: Date.now(),
      authUntil: Date.now() + 60_000,
    };
    const socket: RoomSocket = {
      attachment,
      send: (text) => frames.push(JSON.parse(text)),
      close: (code, reason) => closed.push({ code, reason }),
    };
    const room = new ChatRoomCore({ database, sockets: () => [socket] });
    const clientNonce = crypto.randomUUID();
    await room.message(socket, JSON.stringify({ type: 'send', clientNonce, body: 'synthetic' }));
    expect(frames).toEqual([{ type: 'error', code: 'not_saved', clientNonce }]);
    expect(frames.some((frame) => (frame as { type?: string }).type === 'ack')).toBe(false);
    expect(closed).toEqual([]);
  });
});

describe('AC-BUD-04 identity writes fail closed', () => {
  it('a member whose first sign-in needs a write is refused, not admitted', async () => {
    const email = 'needs-write@example.test';
    const now = Date.now();
    await healthy.db
      .insert(users)
      .values({
        id: '01900000-0000-7000-8000-0000000000f1',
        authEmail: email,
        displayName: 'Needs Write',
        displayNameNorm: normalizeName('Needs Write'),
        status: 'active',
        role: 'member',
        accessSub: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const response = await send(email, 'GET', '/members');
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('unavailable');
  });

  it('a page navigation (accept: text/html) whose load hits a D1 failure renders an HTML 503 error page', async () => {
    const failingLoad = await createHarness(database, {
      appearance: true,
      resolve: async () => {
        const err = new Error('D1_ERROR: database overloaded: timeout');
        err.name = 'D1Error';
        throw err;
      },
    });
    const response = await failingLoad.send('/members', {
      headers: {
        ...(await failingLoad.as(MEMBER)),
        accept: 'text/html,application/xhtml+xml',
      },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(
      html.includes(t('en', 'error.unavailable')) || html.includes(t('vi', 'error.unavailable')),
    ).toBe(true);
    expect(html.trim().startsWith('<')).toBe(true);
  });

  it.each([
    [
      'CPU time limit reset',
      () => new Error('D1_ERROR: D1 DB exceeded its CPU time limit and was reset'),
    ],
    [
      'isolate memory limit reset',
      () => new Error('D1 DB isolate exceeded its memory limit and was reset'),
    ],
    [
      'transient issue on remote node',
      () => new Error('Cannot resolve D1 DB due to transient issue on remote node'),
    ],
    [
      'reset because code was updated',
      () => new Error('D1 DB was reset because its code was updated'),
    ],
    [
      'overloaded / requests queued',
      () => new Error('D1_ERROR: D1 DB is overloaded, requests queued for too long'),
    ],
    [
      'free-plan daily read/write limit',
      () => new Error('D1_ERROR: Exceeded daily write limit on the D1 Free plan'),
    ],
  ] as const)(
    'documented transient D1 error (%s) answers 503 unavailable',
    async (_label, makeError) => {
      const transient = await createHarness(database, {
        appearance: true,
        resolve: async () => {
          throw makeError();
        },
      });
      const response = await transient.send('/api/v1/posts', {
        method: 'POST',
        headers: {
          ...(await transient.as(MEMBER)),
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Synthetic', body: 'Synthetic' }),
      });
      expect(response.status).toBe(503);
      expect((await errorOf(response)).code).toBe('unavailable');
    },
  );

  it.each([
    ['plain Error', () => new Error('boom')],
    [
      'UNIQUE constraint failure',
      () => {
        const err = new Error(
          'D1_ERROR: UNIQUE constraint failed: users.auth_email: SQLITE_CONSTRAINT',
        );
        err.name = 'D1Error';
        return err;
      },
    ],
    [
      'D1 type error',
      () => {
        const err = new Error(
          "D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'",
        );
        err.name = 'D1Error';
        return err;
      },
    ],
    [
      'SQLite syntax error',
      () => {
        const err = new Error('D1_ERROR: near "from": syntax error: SQLITE_ERROR');
        err.name = 'D1Error';
        return err;
      },
    ],
  ] as const)(
    'non-transient %s stays 500 with R-API-02 internal error body, not 503 unavailable',
    async (_label, makeError) => {
      const buggy = await createHarness(database, {
        appearance: true,
        resolve: async () => {
          throw makeError();
        },
      });
      const response = await buggy.send('/api/v1/posts', {
        method: 'POST',
        headers: {
          ...(await buggy.as(MEMBER)),
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'Synthetic', body: 'Synthetic' }),
      });
      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe('internal');
    },
  );

  it('R-API-02 any other /api/ 5xx answers the internal envelope; an envelope already sent is kept', async () => {
    const raw = await createHarness(database, {
      appearance: true,
      resolve: async (event) =>
        event.url.searchParams.has('enveloped')
          ? apiError('unavailable', { requestId: event.locals.requestId, locale: 'en' })
          : new Response('bad gateway', { status: 502 }),
    });
    const headers = await raw.as(MEMBER);
    const gateway = await raw.send('/api/v1/posts', { headers });
    expect(gateway.status).toBe(500);
    expect((await errorOf(gateway)).code).toBe('internal');
    const enveloped = await raw.send('/api/v1/posts?enveloped=1', { headers });
    expect(enveloped.status).toBe(503);
    expect((await errorOf(enveloped)).code).toBe('unavailable');
  });
});
