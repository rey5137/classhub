import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { DEFAULT_VISIBILITY, PROFILE_FIELDS } from '../../src/lib/contracts/profile';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import {
  auditEvents,
  chatMessages,
  comments,
  invites,
  posts,
  profileContacts,
  users,
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, recordingHub, type Harness } from '../fixtures/pipeline-harness';
import { addMedia, addMember, mediaDeleted, resolveProfileRoute } from '../fixtures/profile-routes';

// §4 through the real pipeline and the real handlers on D1.

let database: Database;
let harness: Harness;
const hub = recordingHub();

const everyone = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, 'members']));
const contactsOf = (tag: string, visibility: Record<string, string> = everyone) => ({
  contactEmail: `${tag}.contact@example.test`,
  phone: '+84912000' + String(tag.length).padStart(3, '0'),
  messagingUrl: `https://zalo.me/${tag}`,
  city: `${tag} city`,
  bio: `${tag} bio`,
  visibilityJson: JSON.stringify(visibility),
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  harness = await createHarness(database, { resolve: resolveProfileRoute, realtime: hub });
});

async function send(as: string, method: string, path: string, body?: unknown) {
  return harness.send(path, {
    method,
    headers: {
      ...(await harness.as(as)),
      ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function errorCode(response: Response) {
  return errorBodySchema.parse(await response.json()).error.code;
}

describe('/api/v1/me (R-PROF-01..07)', () => {
  it('AC-PROF-03 a new member’s phone, contact email, messaging URL and city stay private until changed', async () => {
    const owner = await addMember(database, 'Phạm Thu Hà');
    const viewer = await addMember(database, 'Viewer One');
    const saved = await send(owner.email, 'PATCH', '/api/v1/me', {
      phone: '+84 912 345 001',
      contactEmail: 'ha.contact@example.test',
      messagingUrl: 'zalo.me/0912345001',
      city: 'Huế',
      bio: 'Hello class',
    });
    expect(saved.status).toBe(200);
    // R-PROF-07: profile JSON is never stored by a cache.
    expect(saved.headers.get('cache-control')).toBe('private, no-store');
    const own = await json(saved);
    expect(own.visibility).toEqual(DEFAULT_VISIBILITY);
    expect(own.authEmail).toBe(owner.email);
    expect(own.profile).toMatchObject({
      phone: { text: '+84912345001', href: 'tel:+84912345001' },
      messagingUrl: { href: 'https://zalo.me/0912345001' },
      city: 'Huế',
    });

    for (const as of [viewer.email, PEOPLE.admin.email]) {
      const seen = await json(await send(as, 'GET', `/api/v1/members/${owner.id}`));
      expect(seen).toEqual({ id: owner.id, displayName: 'Phạm Thu Hà', bio: 'Hello class' });
    }

    await send(owner.email, 'PATCH', '/api/v1/me', { visibility: { city: 'members' } });
    const later = await json(await send(viewer.email, 'GET', `/api/v1/members/${owner.id}`));
    expect(later.city).toBe('Huế');
    expect(later.phone).toBeUndefined();
  });

  it('AC-PROF-04 refuses a javascript: link with a field error and changes nothing', async () => {
    const owner = await addMember(database, 'Link Tester');
    const refused = await send(owner.email, 'PATCH', '/api/v1/me', {
      messagingUrl: 'javascript:alert(1)',
      city: 'Hà Nội',
    });
    expect(refused.status).toBe(400);
    const body = errorBodySchema.parse(await refused.json());
    expect(body.error.code).toBe('validation');
    expect(Object.keys(body.error.fields ?? {})).toEqual(['messagingUrl']);
    const rows = await database.db
      .select()
      .from(profileContacts)
      .where(eq(profileContacts.userId, owner.id));
    expect(rows).toEqual([]);
  });

  it('renames with the shared normalizer and refuses an empty display name', async () => {
    const owner = await addMember(database, 'Rename Me');
    expect(
      (await send(owner.email, 'PATCH', '/api/v1/me', { displayName: 'Đỗ Bảo Ngọc' })).status,
    ).toBe(200);
    const [row] = await database.db
      .select({ norm: users.displayNameNorm })
      .from(users)
      .where(eq(users.id, owner.id));
    expect(row?.norm).toBe('do bao ngoc');
    expect(
      await errorCode(await send(owner.email, 'PATCH', '/api/v1/me', { displayName: ' ' })),
    ).toBe('validation');
  });

  it('AC-AUTH-09 the 21st profile write in an hour answers 429 with Retry-After', async () => {
    const owner = await addMember(database, 'Busy Writer');
    for (let index = 0; index < 20; index += 1) {
      const response = await send(owner.email, 'PATCH', '/api/v1/me', { city: `City ${index}` });
      expect([index, response.status]).toEqual([index, 200]);
    }
    const limited = await send(owner.email, 'PATCH', '/api/v1/me', { city: 'One too many' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await errorCode(limited)).toBe('rate_limited');
    const [row] = await database.db
      .select({ city: profileContacts.city })
      .from(profileContacts)
      .where(eq(profileContacts.userId, owner.id));
    expect(row?.city).toBe('City 19');
  });
});

describe('/api/v1/me/export (R-PROF-09)', () => {
  it('AC-PROF-05 holds only the requester’s data; another member’s contacts are absent', async () => {
    const owner = await addMember(database, 'Export Owner', { contacts: contactsOf('exporter') });
    const other = await addMember(database, 'Other Classmate', { contacts: contactsOf('other') });
    const now = Date.now();
    await database.db.insert(posts).values({
      id: `${owner.id.slice(0, -4)}0001`,
      authorId: owner.id,
      title: 'My thread',
      bodyMd: 'my words',
      createdAt: now,
    });
    await database.db.insert(comments).values([
      {
        id: `${owner.id.slice(0, -4)}0002`,
        postId: `${owner.id.slice(0, -4)}0001`,
        authorId: owner.id,
        bodyMd: 'my reply',
        createdAt: now,
      },
      {
        id: `${owner.id.slice(0, -4)}0003`,
        postId: `${owner.id.slice(0, -4)}0001`,
        authorId: other.id,
        bodyMd: 'their reply',
        createdAt: now,
      },
    ]);
    await database.db.insert(chatMessages).values([
      {
        id: `${owner.id.slice(0, -4)}0004`,
        roomId: 'main',
        senderId: owner.id,
        clientNonce: 'n1',
        body: 'my chat',
        createdAt: now,
      },
      {
        id: `${owner.id.slice(0, -4)}0005`,
        roomId: 'main',
        senderId: other.id,
        clientNonce: 'n2',
        body: 'their chat',
        createdAt: now,
      },
    ]);

    const response = await send(owner.email, 'GET', '/api/v1/me/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const text = await response.text();
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(data.profile).toMatchObject({ phone: '+84912000008', city: 'exporter city' });
    expect((data.posts as unknown[]).length).toBe(1);
    expect((data.comments as { bodyMd: string }[]).map((c) => c.bodyMd)).toEqual(['my reply']);
    expect((data.chatMessages as { body: string }[]).map((m) => m.body)).toEqual(['my chat']);
    for (const foreign of [
      'other.contact@example.test',
      'https://zalo.me/other',
      'other city',
      'their reply',
      'their chat',
      other.email,
      // R-PROF-05: not even the requester's own login email.
      owner.email,
    ]) {
      expect([foreign, text.includes(foreign)]).toEqual([foreign, false]);
    }
  });
});

describe('deletion (R-PROF-11, R-PROF-13)', () => {
  async function contentOf(id: string) {
    const now = Date.now();
    const postId = `${id.slice(0, -4)}0a01`;
    await database.db.insert(posts).values({
      id: postId,
      authorId: id,
      title: 'Reunion',
      bodyMd: 'see you',
      createdAt: now,
      commentCount: 1,
    });
    await database.db.insert(comments).values({
      id: `${id.slice(0, -4)}0a02`,
      postId,
      authorId: id,
      bodyMd: 'my comment',
      createdAt: now,
    });
    await database.db.insert(chatMessages).values({
      id: `${id.slice(0, -4)}0a03`,
      roomId: 'main',
      senderId: id,
      clientNonce: `n-${id}`,
      body: 'hello all',
      createdAt: now,
    });
    await addMedia(database, id);
    return postId;
  }

  it('AC-PROF-08 a pending request hides the contact fields at once, and repeats change nothing', async () => {
    const owner = await addMember(database, 'Leaving Soon', { contacts: contactsOf('leaving') });
    const viewer = await addMember(database, 'Still Here');
    const before = await json(await send(viewer.email, 'GET', `/api/v1/members/${owner.id}`));
    expect(before.phone).toBeDefined();

    const first = await send(owner.email, 'POST', '/api/v1/me/deletion-request', {
      keepContent: true,
    });
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ changed: true, keepContent: true });
    // A repeated request answers the standing one and keeps its choice.
    const again = await send(owner.email, 'POST', '/api/v1/me/deletion-request', {
      keepContent: false,
    });
    expect(await json(again)).toMatchObject({ changed: false, keepContent: true });
    const audits = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, owner.id));
    expect(audits.map((row) => row.action)).toEqual(['member.deletion_requested']);

    for (const as of [viewer.email, PEOPLE.admin.email]) {
      const seen = await json(await send(as, 'GET', `/api/v1/members/${owner.id}`));
      expect(seen).toEqual({ id: owner.id, displayName: 'Leaving Soon', bio: 'leaving bio' });
    }
    const own = await json(await send(owner.email, 'GET', '/api/v1/me'));
    expect((own.profile as Record<string, unknown>).phone).toBeDefined();
    // R-PROF-11: the request is shown to admins.
    const list = await json(await send(PEOPLE.admin.email, 'GET', '/api/v1/admin/invites'));
    const row = (list.items as { userId: string; deletionRequestedAt: number | null }[]).find(
      (item) => item.userId === owner.id,
    );
    expect(row?.deletionRequestedAt).toEqual(expect.any(Number));
  });

  it('AC-PROF-06 AC-PROF-08 completion clears contacts, renders Former member, deletes content and tombstones the email', async () => {
    const owner = await addMember(database, 'Gone Member', { contacts: contactsOf('gone') });
    const postId = await contentOf(owner.id);
    await send(owner.email, 'POST', '/api/v1/me/deletion-request', { keepContent: false });

    const done = await send(PEOPLE.admin.email, 'PATCH', `/api/v1/admin/members/${owner.id}`, {
      deletion: 'complete',
    });
    expect(done.status).toBe(200);
    expect(await json(done)).toEqual({ ok: true, changed: true });
    expect(hub.disconnected).toContain(owner.id);
    // Idempotent: a second completion changes nothing and audits nothing.
    const repeat = await send(PEOPLE.admin.email, 'PATCH', `/api/v1/admin/members/${owner.id}`, {
      deletion: 'complete',
    });
    expect(await json(repeat)).toEqual({ ok: true, changed: false });

    const tombstone = `deleted+${owner.id}@invalid`;
    const [user] = await database.db.select().from(users).where(eq(users.id, owner.id));
    expect(user).toMatchObject({
      status: 'suspended',
      authEmail: tombstone,
      displayName: 'Cựu thành viên',
      preferredName: null,
      accessSub: null,
    });
    expect(
      await database.db.select().from(profileContacts).where(eq(profileContacts.userId, owner.id)),
    ).toEqual([]);
    expect(await database.db.select().from(invites).where(eq(invites.email, owner.email))).toEqual(
      [],
    );
    const [invite] = await database.db.select().from(invites).where(eq(invites.email, tombstone));
    expect(invite?.status).toBe('revoked');
    const [post] = await database.db.select().from(posts).where(eq(posts.id, postId));
    expect(post).toMatchObject({
      title: '',
      bodyMd: '',
      deletedAt: expect.any(Number),
      commentCount: 0,
    });
    const [message] = await database.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.senderId, owner.id));
    expect(message).toMatchObject({ body: '', deletedAt: expect.any(Number) });
    // The photo goes with the content and the avatar with the profile; class media stay.
    expect(await mediaDeleted(database, owner.id)).toEqual({
      photo: true,
      avatar: true,
      site: false,
    });
    const audits = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, owner.id));
    expect(audits.map((row) => row.action).sort()).toEqual([
      'member.deletion_completed',
      'member.deletion_requested',
    ]);

    const seen = await json(await send(PEOPLE.active.email, 'GET', `/api/v1/members/${owner.id}`));
    expect(seen).toEqual({ id: owner.id, displayName: 'Cựu thành viên' });

    // R-AUTH-08: the same person can be invited again.
    const reinvite = await send(PEOPLE.admin.email, 'POST', '/api/v1/admin/invites', {
      email: owner.email,
      displayName: 'Back Again',
    });
    expect(reinvite.status).toBe(201);
  });

  it('R-PROF-11 the /admin completion names the original email to remove from Access', async () => {
    const owner = await addMember(database, 'Policy Leaver');
    await send(owner.email, 'POST', '/api/v1/me/deletion-request', { keepContent: true });
    const complete = async () => {
      const response = await harness.send('/admin?/member', {
        method: 'POST',
        headers: {
          ...(await harness.as(PEOPLE.admin.email)),
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ userId: owner.id, deletion: 'complete' }).toString(),
      });
      return { status: response.status, body: await json(response) };
    };
    expect(await complete()).toEqual({
      status: 200,
      body: { action: 'member', done: 'deleted', email: owner.email },
    });
    // A repeat has nothing left to tell, and never the tombstone.
    expect(await complete()).toEqual({ status: 200, body: { action: 'member', done: 'updated' } });
  });

  it('AC-PROF-06 keeps the content under Former member when the member asked to', async () => {
    const owner = await addMember(database, 'Kept Member', { contacts: contactsOf('kept') });
    const postId = await contentOf(owner.id);
    await send(owner.email, 'POST', '/api/v1/me/deletion-request', { keepContent: true });
    await send(PEOPLE.admin.email, 'PATCH', `/api/v1/admin/members/${owner.id}`, {
      deletion: 'complete',
    });
    const [post] = await database.db.select().from(posts).where(eq(posts.id, postId));
    expect(post).toMatchObject({
      authorId: owner.id,
      title: 'Reunion',
      bodyMd: 'see you',
      deletedAt: null,
    });
    const [user] = await database.db.select().from(users).where(eq(users.id, owner.id));
    expect(user?.displayName).toBe('Cựu thành viên');
    // Kept content keeps its photo; the avatar is part of the cleared profile.
    expect(await mediaDeleted(database, owner.id)).toEqual({
      photo: false,
      avatar: true,
      site: false,
    });
    expect(
      await database.db.select().from(profileContacts).where(eq(profileContacts.userId, owner.id)),
    ).toEqual([]);
  });

  it('refuses a completion with no request, by a member, or of the last active admin', async () => {
    const owner = await addMember(database, 'Not Asking', { contacts: contactsOf('asking') });
    const none = await send(PEOPLE.admin.email, 'PATCH', `/api/v1/admin/members/${owner.id}`, {
      deletion: 'complete',
    });
    expect([none.status, await errorCode(none)]).toEqual([409, 'conflict']);

    await send(owner.email, 'POST', '/api/v1/me/deletion-request', { keepContent: true });
    const byMember = await send(PEOPLE.active.email, 'PATCH', `/api/v1/admin/members/${owner.id}`, {
      deletion: 'complete',
    });
    expect(byMember.status).toBe(403);

    // The class admin is the only active admin here.
    await send(PEOPLE.admin.email, 'POST', '/api/v1/me/deletion-request', { keepContent: true });
    const self = await send(
      PEOPLE.admin.email,
      'PATCH',
      `/api/v1/admin/members/${PEOPLE.admin.id}`,
      { deletion: 'complete' },
    );
    expect([self.status, (await json(self)).error]).toEqual([
      409,
      expect.objectContaining({ code: 'conflict' }),
    ]);
    const [admin] = await database.db.select().from(users).where(eq(users.id, PEOPLE.admin.id));
    expect(admin).toMatchObject({ status: 'active', authEmail: PEOPLE.admin.email });
    await database.db
      .update(users)
      .set({ deletionRequestedAt: null })
      .where(eq(users.id, PEOPLE.admin.id));
  });

  it('AC-PROF-08 a suspended owner’s page shows only the display name', async () => {
    const owner = await addMember(database, 'Paused Member', {
      status: 'suspended',
      contacts: contactsOf('paused'),
    });
    for (const as of [PEOPLE.active.email, PEOPLE.admin.email]) {
      expect(await json(await send(as, 'GET', `/api/v1/members/${owner.id}`))).toEqual({
        id: owner.id,
        displayName: 'Paused Member',
      });
    }
    expect((await send(PEOPLE.active.email, 'GET', '/api/v1/members/no-such-id')).status).toBe(404);
  });
});

describe('the login email sweep (R-PROF-05)', () => {
  it('AC-PROF-02 no API response carries a login email except /me for its owner and the admin invite list', async () => {
    // A contact email equal to the login email is shown only through its own visibility.
    const twin = await addMember(database, 'Same Address', {
      contacts: { ...contactsOf('twin', { ...everyone, contact_email: 'private' }) },
    });
    await database.db
      .update(profileContacts)
      .set({ contactEmail: twin.email })
      .where(eq(profileContacts.userId, twin.id));
    const members = await database.db.select({ id: users.id, email: users.authEmail }).from(users);
    const emails = members.map((row) => row.email);

    for (const viewer of [PEOPLE.active.email, PEOPLE.admin.email, twin.email]) {
      const paths = [
        '/api/v1/me',
        '/api/v1/me/export',
        '/api/v1/members',
        '/api/v1/members?q=s',
        ...members.map((row) => `/api/v1/members/${row.id}`),
        // Page data too (R-NAV-03): the directory, every member page and /profile.
        '/members',
        '/members?q=s',
        '/profile',
        ...members.map((row) => `/members/${row.id}`),
      ];
      for (const path of paths) {
        const response = await send(viewer, 'GET', path);
        expect([path, response.status]).toEqual([path, 200]);
        const text = await response.text();
        // The twin's own views carry its contact email, which equals its login email.
        const own =
          path === '/api/v1/me' ||
          (viewer === twin.email &&
            [
              '/api/v1/me/export',
              `/api/v1/members/${twin.id}`,
              `/members/${twin.id}`,
              '/profile',
            ].includes(path));
        const allowed = own ? [viewer] : [];
        for (const email of emails) {
          if (allowed.includes(email)) continue;
          expect([viewer, path, email, text.includes(email)]).toEqual([viewer, path, email, false]);
        }
      }
    }
    // The admin invite list is the one place admins see them (R-AUTH-10).
    const list = await (await send(PEOPLE.admin.email, 'GET', '/api/v1/admin/invites')).text();
    expect(list).toContain(twin.email);
  });
});

describe('contact data stays out of logs and audit rows (INV-5)', () => {
  it('AC-AUTH-12 a profile write, a deletion request and its completion log no contact value', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
    );
    try {
      const owner = await addMember(database, 'Quiet Logger');
      const values = {
        phone: '+84 999 888 777',
        contactEmail: 'quiet.logger.contact@example.test',
        messagingUrl: 'https://zalo.me/quietlogger',
        city: 'Quiet City',
        bio: 'quiet bio',
      };
      expect((await send(owner.email, 'PATCH', '/api/v1/me', values)).status).toBe(200);
      await send(owner.email, 'PATCH', '/api/v1/me', { messagingUrl: 'javascript:quiet()' });
      await send(owner.email, 'POST', '/api/v1/me/deletion-request', { keepContent: false });
      await send(PEOPLE.admin.email, 'PATCH', `/api/v1/admin/members/${owner.id}`, {
        deletion: 'complete',
      });
      expect(lines.length).toBeGreaterThan(0);
      const logged = lines.join('\n');
      const audits = JSON.stringify(await database.db.select().from(auditEvents));
      for (const value of [...Object.values(values), '84999888777', 'quiet()', owner.email]) {
        expect([value, logged.includes(value), audits.includes(value)]).toEqual([
          value,
          false,
          false,
        ]);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('/profile form actions (R-PROF-10, R-PROF-11)', () => {
  async function post(as: string, action: string, fields: Record<string, string>) {
    const response = await harness.send(`/profile?/${action}`, {
      method: 'POST',
      headers: {
        ...(await harness.as(as)),
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    });
    return { status: response.status, body: await json(response) };
  }

  it('saves fields and visibility, refuses a bad link by field, then clears every optional field', async () => {
    const owner = await addMember(database, 'Form Owner', { preferredName: 'Formy' });
    await addMedia(database, owner.id);
    const saved = await post(owner.email, 'save', {
      displayName: 'Form Owner',
      preferred_name: 'Formy',
      phone: '+84 912 345 999',
      city: 'Vinh',
      bio: '',
      contact_email: '',
      messaging_url: '',
      'visibility.city': 'members',
    });
    expect(saved).toEqual({ status: 200, body: { action: 'save', done: 'saved' } });
    const page = await json(await send(PEOPLE.active.email, 'GET', `/members/${owner.id}`));
    expect(page.profile).toEqual({
      id: owner.id,
      displayName: 'Form Owner',
      preferredName: 'Formy',
      city: 'Vinh',
    });

    const refused = await post(owner.email, 'save', {
      displayName: 'Form Owner',
      messaging_url: 'data:text/html,x',
    });
    expect(refused.status).toBe(400);
    expect(Object.keys(refused.body.fields as object)).toEqual(['messagingUrl']);

    expect(await post(owner.email, 'clear', {})).toEqual({
      status: 200,
      body: { action: 'clear', done: 'cleared' },
    });
    const [user] = await database.db.select().from(users).where(eq(users.id, owner.id));
    expect(user).toMatchObject({
      displayName: 'Form Owner',
      preferredName: null,
      preferredNameNorm: null,
      avatarMediaId: null,
    });
    const [contacts] = await database.db
      .select()
      .from(profileContacts)
      .where(eq(profileContacts.userId, owner.id));
    expect(contacts).toMatchObject({
      phone: null,
      city: null,
      bio: null,
      contactEmail: null,
      messagingUrl: null,
    });
    // R-PROF-10: the avatar pictures go too; photos and class media stay.
    expect(await mediaDeleted(database, owner.id)).toEqual({
      photo: false,
      avatar: true,
      site: false,
    });
    // The visibility choices survive a clear.
    expect(JSON.parse(contacts!.visibilityJson).city).toBe('members');
  });

  it('records a deletion request with the chosen content handling', async () => {
    const owner = await addMember(database, 'Form Leaver');
    expect((await post(owner.email, 'deletion', {})).status).toBe(400);
    expect(await post(owner.email, 'deletion', { keepContent: 'delete' })).toEqual({
      status: 200,
      body: { action: 'deletion', done: 'requested' },
    });
    const [user] = await database.db.select().from(users).where(eq(users.id, owner.id));
    expect(user).toMatchObject({
      deletionRequestedAt: expect.any(Number),
      deletionKeepContent: false,
    });
    const page = await json(await send(owner.email, 'GET', '/profile'));
    expect(page.deletionRequestedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(page)).not.toContain(owner.email);
  });
});
