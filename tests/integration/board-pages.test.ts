import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommentItem, PostItem, PostSummary } from '../../src/lib/contracts/discussions';
import type { GalleryItem } from '../../src/lib/contracts/media';
import type { SiteSettings } from '../../src/lib/contracts/settings';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import type { Member } from '../../src/lib/server/auth/membership';
import type { AppContext } from '../../src/lib/server/context';
import {
  comments,
  infoPages,
  media,
  posts,
  rateEvents,
  users,
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import { defaultSettings } from '../../src/lib/server/services/settings';
import { load as homeLoad } from '../../src/routes/+page.server';
import {
  actions as boardActions,
  load as boardLoad,
} from '../../src/routes/discussions/+page.server';
import {
  actions as threadActions,
  load as threadLoad,
} from '../../src/routes/discussions/[id]/+page.server';
import { seedDeletedMedia } from '../fixtures/housekeeping';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { ORIGIN } from '../fixtures/pipeline-harness';

// R-BRD-01, R-BRD-06..08, R-AUTH-17: the Home, board and thread loaders and the form
// actions behind them, called the way SvelteKit calls them.

const OTHER = { id: '01900000-0000-7000-8000-000000000009', email: 'other.member@example.test' };
const member: Member = { id: PEOPLE.active.id, role: 'member', displayName: 'Nguyễn Hoạt Động' };
const other: Member = { id: OTHER.id, role: 'member', displayName: 'Trần Bạn Khác' };
const admin: Member = { id: PEOPLE.admin.id, role: 'admin', displayName: 'Lớp Trưởng' };
// Before the real clock, so a comment the actions write (at Date.now()) sorts last.
const NOW = 1_700_000_000_000;

let database: Database;
/** Every SQL statement the recording database prepared, for the "no query" checks. */
const prepared: string[] = [];
let recording: Database;

function locals(viewer: Member, settings: SiteSettings = defaultSettings, db = database) {
  return {
    member: viewer,
    context: { database: db } as unknown as AppContext,
    locale: 'en' as const,
    settings,
  };
}

interface HomeData {
  greeting: string;
  welcome: { html: string; bannerMediaId: string | null };
  pinnedInfo: { slug: string; title: string }[];
  reunion: { title: string; bodyHtml: string } | null;
  photos: GalleryItem[] | null;
  threads: { pinned: PostSummary[]; active: PostSummary[] } | null;
}
interface BoardData {
  threads: PostSummary[];
  nextCursor: string | null;
  paged: boolean;
  canCreate: boolean;
}
interface ThreadData {
  post: PostItem;
  comments: CommentItem[];
  nextCursor: string | null;
  paged: boolean;
  canComment: boolean;
}
const home = (viewer: Member, settings?: SiteSettings, db?: Database) =>
  homeLoad({ locals: locals(viewer, settings, db) } as unknown as Parameters<
    typeof homeLoad
  >[0]) as unknown as Promise<HomeData>;

const board = (viewer: Member, query = '') =>
  boardLoad({
    locals: locals(viewer),
    url: new URL(`${ORIGIN}/discussions${query}`),
  } as unknown as Parameters<typeof boardLoad>[0]) as unknown as Promise<BoardData>;

const thread = (viewer: Member, id: string, query = '', settings?: SiteSettings, db?: Database) =>
  threadLoad({
    locals: locals(viewer, settings, db),
    params: { id },
    url: new URL(`${ORIGIN}/discussions/${id}${query}`),
  } as unknown as Parameters<typeof threadLoad>[0]) as unknown as Promise<ThreadData>;

type Outcome = { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;

/** Runs a form action; a redirect comes back as `{ redirect }` instead of a throw. */
async function act(
  actions: Record<string, unknown>,
  name: string,
  viewer: Member,
  fields: Record<string, string>,
  params: Record<string, string> = {},
): Promise<Outcome> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  try {
    return (await (actions[name] as (event: unknown) => Promise<Outcome>)({
      locals: locals(viewer),
      params,
      request: new Request(`${ORIGIN}/discussions`, { method: 'POST', body }),
    })) as Outcome;
  } catch (thrown) {
    const redirect = thrown as { status?: number; location?: string };
    if (redirect.location) return { redirect: redirect.location, status: redirect.status };
    throw thrown;
  }
}

async function insertThread(
  overrides: Partial<typeof posts.$inferInsert> = {},
): Promise<typeof posts.$inferSelect> {
  const row = {
    id: uuidv7(),
    authorId: member.id,
    title: 'A thread',
    bodyMd: 'Body',
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
    ...overrides,
  };
  const [stored] = await database.db.insert(posts).values(row).returning();
  return stored!;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const d1 = env.DB as unknown as Parameters<typeof createD1Database>[0];
  database = createD1Database(d1);
  // The same D1 binding, with every prepared statement written down first.
  recording = createD1Database(
    new Proxy(d1, {
      get(target, key) {
        if (key === 'prepare') {
          return (query: string) => {
            prepared.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
  await seedMembership(database);
  await database.db
    .insert(users)
    .values({
      id: OTHER.id,
      authEmail: OTHER.email,
      displayName: other.displayName,
      displayNameNorm: 'tran ban khac',
      role: 'member',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .onConflictDoNothing();
});

beforeEach(async () => {
  prepared.length = 0;
  await database.db.delete(comments);
  await database.db.delete(posts);
  await database.db.delete(media);
  await database.db.delete(infoPages);
  await database.db.delete(rateEvents);
});

describe('Home (R-BRD-01)', () => {
  async function seedHome() {
    await database.db.insert(infoPages).values([
      {
        id: uuidv7(),
        slug: 'reunion',
        title: 'Reunion',
        bodyMd: '**Saturday**',
        isPinned: true,
        sortOrder: 0,
        updatedBy: admin.id,
        updatedAt: NOW,
      },
      {
        id: uuidv7(),
        slug: 'fund',
        title: 'Class fund',
        bodyMd: 'x',
        isPinned: true,
        sortOrder: 1,
        updatedBy: admin.id,
        updatedAt: NOW,
      },
      {
        id: uuidv7(),
        slug: 'rules',
        title: 'Rules',
        bodyMd: 'x',
        isPinned: false,
        sortOrder: 2,
        updatedBy: admin.id,
        updatedAt: NOW,
      },
    ]);
    const photos = [];
    for (let index = 0; index < 14; index += 1) {
      photos.push(await seedDeletedMedia(database, { deletedAt: null, createdAt: NOW + index }));
    }
    // The pinned thread is the most recently active one: it still stays out of the active list.
    await insertThread({ title: 'Pinned', isPinned: true, lastActivityAt: NOW + 100 });
    for (let index = 0; index < 7; index += 1) {
      await insertThread({ title: `Thread ${index}`, lastActivityAt: NOW + index });
    }
    return photos;
  }

  it('R-BRD-01 shows the welcome, pinned info and threads, the reunion card, 12 newest photos and the 5 most active unpinned threads', async () => {
    const photos = await seedHome();
    const data = await home(member, {
      ...defaultSettings,
      welcome: 'Hello **class**',
      bannerMediaId: photos[0]!.id,
    });
    expect(data.greeting).toBe(member.displayName);
    expect(data.welcome).toEqual({
      html: '<p>Hello <strong>class</strong></p>',
      bannerMediaId: photos[0]!.id,
    });
    // The reunion page is the card, not a second pinned link; unpinned pages stay off Home.
    expect(data.pinnedInfo).toEqual([{ slug: 'fund', title: 'Class fund' }]);
    expect(data.reunion).toEqual({
      title: 'Reunion',
      bodyHtml: '<p><strong>Saturday</strong></p>',
    });
    expect(data.photos!.map((photo) => photo.id)).toEqual(
      photos
        .slice(-12)
        .reverse()
        .map((photo) => photo.id),
    );
    expect(data.threads!.pinned.map((post) => post.title)).toEqual(['Pinned']);
    expect(data.threads!.active.map((post) => post.title)).toEqual([
      'Thread 6',
      'Thread 5',
      'Thread 4',
      'Thread 3',
      'Thread 2',
    ]);
    // INV-5: an author goes through the projection; no contact field reaches the page.
    expect(Object.keys(data.threads!.active[0]!.author).sort()).toEqual(['displayName', 'id']);
  });

  it('R-BRD-01 R-NAV-02 with memories and discussions off Home reads no photo or post and shows neither section', async () => {
    await seedHome();
    const off = {
      ...defaultSettings,
      features: {
        memories: false,
        discussions: false,
        chat: true,
        join: false,
        notifications: true,
      },
    };
    const data = await home(member, off, recording);
    expect(data.photos).toBeNull();
    expect(data.threads).toBeNull();
    expect(prepared.length).toBeGreaterThan(0);
    expect(prepared.filter((query) => /"(media|posts)"/.test(query))).toEqual([]);

    // The same loader with both on does read them, so the check above can fail.
    prepared.length = 0;
    await home(member, defaultSettings, recording);
    expect(prepared.some((query) => /from "media"/.test(query))).toBe(true);
    expect(prepared.some((query) => /from "posts"/.test(query))).toBe(true);
  });

  it('R-BRD-01 a fresh site with no data renders every section empty', async () => {
    const data = await home(member);
    expect(data).toMatchObject({
      welcome: { html: '', bannerMediaId: null },
      pinnedInfo: [],
      reunion: null,
      photos: [],
      threads: { pinned: [], active: [] },
    });
  });
});

describe('the board (R-BRD-06, R-AUTH-17)', () => {
  it('R-BRD-06 the loader passes the cursor through: pinned first, the next page follows on, a bad cursor is a 400', async () => {
    await insertThread({ title: 'Pinned', isPinned: true, lastActivityAt: NOW - 100_000 });
    for (let index = 0; index < 24; index += 1) {
      await insertThread({ title: `T${index}`, lastActivityAt: NOW + index });
    }
    const first = await board(member);
    expect(first.threads).toHaveLength(20);
    expect(first.threads[0]!.title).toBe('Pinned');
    expect(first.paged).toBe(false);
    expect(first.canCreate).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await board(member, `?cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.paged).toBe(true);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.threads, ...second.threads].map((post) => post.title);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);

    await expect(board(member, '?cursor=nonsense')).rejects.toMatchObject({ status: 400 });
  });

  it('R-AUTH-17 the new-thread form creates the thread and redirects to it', async () => {
    const outcome = await act(boardActions, 'create', member, {
      title: 'Picnic',
      body: '**bold**\n\n- one\n- two\n\n[site](https://example.test)',
    });
    expect(outcome.status).toBe(303);
    const [row] = await database.db.select().from(posts);
    expect(outcome.redirect).toBe(`/discussions/${row!.id}`);
    expect(row).toMatchObject({ title: 'Picnic', authorId: member.id });
  });

  it('AC-BRD-06 the new-thread form refuses an over-long title or an empty body with field errors and keeps the text', async () => {
    const outcome = await act(boardActions, 'create', member, {
      title: 'x'.repeat(161),
      body: '  ',
    });
    expect(outcome.status).toBe(400);
    expect(Object.keys(outcome.data!.fields as object).sort()).toEqual(['body', 'title']);
    expect(outcome.data!.values).toEqual({ title: 'x'.repeat(161), body: '  ' });
    expect(await database.db.select().from(posts)).toEqual([]);
  });

  it('R-AUTH-21 the eleventh post in a minute is a 429 form error', async () => {
    for (let index = 0; index < 10; index += 1) {
      expect(
        (await act(boardActions, 'create', member, { title: `T${index}`, body: 'b' })).status,
      ).toBe(303);
    }
    const refused = await act(boardActions, 'create', member, { title: 'T10', body: 'b' });
    expect(refused.status).toBe(429);
    expect(refused.data!.action).toBe('create');
  });
});

describe('a thread (R-BRD-07, R-BRD-08)', () => {
  it('R-BRD-08 an unknown, malformed or deleted thread is the same 404', async () => {
    const gone = await insertThread({ deletedAt: NOW });
    for (const id of [uuidv7(), 'not-an-id', gone.id]) {
      await expect(thread(member, id)).rejects.toMatchObject({ status: 404 });
    }
    const live = await insertThread();
    await expect(thread(member, live.id, '?cursor=nonsense')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('R-BRD-07 comments page oldest first, 20 at a time, and a deleted one followed by others shows in place', async () => {
    const post = await insertThread({ commentCount: 22 });
    const rows = Array.from({ length: 22 }, (_, index) => ({
      id: uuidv7(),
      postId: post.id,
      authorId: other.id,
      bodyMd: `c${index}`,
      createdAt: NOW + index,
      updatedAt: NOW + index,
      deletedAt: index === 1 ? NOW + 100 : null,
    }));
    await database.db.insert(comments).values(rows.slice(0, 11));
    await database.db.insert(comments).values(rows.slice(11));
    const first = await thread(member, post.id);
    expect(first.comments).toHaveLength(20);
    expect(first.comments[1]).toMatchObject({ deleted: true });
    expect(first.comments[2]).toMatchObject({ deleted: false, bodyHtml: '<p>c2</p>' });
    const second = await thread(
      member,
      post.id,
      `?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.comments.map((row) => ('bodyMd' in row ? row.bodyMd : null))).toEqual([
      'c20',
      'c21',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('AC-BRD-03 a locked thread hides the comment form from everyone and refuses the action with a form error; unlocking allows it', async () => {
    const post = await insertThread();
    expect((await thread(other, post.id)).canComment).toBe(true);
    expect((await act(threadActions, 'lock', admin, { value: 'true' }, { id: post.id })).done).toBe(
      'locked',
    );
    for (const viewer of [other, admin]) {
      const data = await thread(viewer, post.id);
      expect(data.post.isLocked).toBe(true);
      expect(data.canComment).toBe(false);
      // A form opened before the lock still posts; the refusal is a form error.
      const refused = await act(
        threadActions,
        'comment',
        viewer,
        { body: 'late' },
        { id: post.id },
      );
      expect(refused.status).toBe(423);
      expect(refused.data).toMatchObject({
        action: 'comment',
        message: 'This discussion is locked and accepts no new replies.',
        values: { body: 'late' },
      });
    }
    expect(await database.db.select().from(comments)).toEqual([]);

    await act(threadActions, 'lock', admin, { value: 'false' }, { id: post.id });
    expect((await thread(other, post.id)).canComment).toBe(true);
    const posted = await act(threadActions, 'comment', other, { body: 'now' }, { id: post.id });
    const [stored] = await database.db.select().from(comments);
    expect(posted).toEqual({
      redirect: `/discussions/${post.id}#comment-${stored!.id}`,
      status: 303,
    });
    expect((await thread(other, post.id)).comments).toHaveLength(1);
  });

  it('R-BRD-07 a posted comment redirects (Post/Redirect/Get) to the page that starts at it, anchored to it', async () => {
    const post = await insertThread({ commentCount: 20 });
    // 20 earlier comments, one deleted with nothing live after it yet: the new comment is the 21st shown.
    const earlier = Array.from({ length: 20 }, (_, index) => ({
      id: uuidv7(),
      postId: post.id,
      authorId: other.id,
      bodyMd: `c${index}`,
      createdAt: NOW + index,
      updatedAt: NOW + index,
      deletedAt: index === 19 ? NOW + 50 : null,
    }));
    await database.db.insert(comments).values(earlier.slice(0, 10));
    await database.db.insert(comments).values(earlier.slice(10));
    const posted = await act(threadActions, 'comment', member, { body: 'late' }, { id: post.id });
    const [fresh] = await database.db.select().from(comments).where(eq(comments.bodyMd, 'late'));
    const location = new URL(posted.redirect as string, ORIGIN);
    expect([posted.status, location.pathname, location.hash]).toEqual([
      303,
      `/discussions/${post.id}`,
      `#comment-${fresh!.id}`,
    ]);
    const page = await thread(member, post.id, location.search);
    expect(page.comments[0]!.id).toBe(fresh!.id);
    // The first page holds the 20 earlier ones, the deleted one now shown in place.
    const first = await thread(member, post.id);
    expect(first.comments.map((row) => row.id)).toEqual(earlier.map((row) => row.id));
  });

  it('R-BRD-04 R-NAV-02 with memories off a thread’s photo reference is the placeholder and no photo is read', async () => {
    const photo = await seedDeletedMedia(database, { deletedAt: null, caption: 'Camp' });
    const post = await insertThread({ bodyMd: `[[photo:${photo.id}]]` });
    expect((await thread(member, post.id)).post.bodyHtml).toContain(`href="/memories/${photo.id}"`);
    const off = { ...defaultSettings, features: { ...defaultSettings.features, memories: false } };
    const data = await thread(member, post.id, '', off, recording);
    expect(data.post.bodyHtml).toBe('<p><em>Photo not shown</em></p>');
    expect(prepared.filter((query) => /"media"/.test(query))).toEqual([]);
  });

  it('AC-BRD-04 a member cannot edit, delete, pin or lock another member’s thread or comment through the forms', async () => {
    const post = await insertThread();
    await act(threadActions, 'comment', member, { body: 'mine' }, { id: post.id });
    const [comment] = await database.db.select().from(comments);
    const params = { id: post.id };
    for (const [name, fields] of [
      ['editPost', { title: 'Hijacked', body: 'x' }],
      ['deletePost', {}],
      ['pin', { value: 'true' }],
      ['lock', { value: 'true' }],
      ['editComment', { commentId: comment!.id, body: 'x' }],
      ['deleteComment', { commentId: comment!.id }],
    ] as const) {
      const refused = await act(threadActions, name, other, fields, params);
      expect([name, refused.status]).toEqual([name, 403]);
    }
    // The owner may edit their own post and comment, but not pin or lock it.
    expect((await act(threadActions, 'pin', member, { value: 'true' }, params)).status).toBe(403);
    expect(
      await act(threadActions, 'editPost', member, { title: 'Mine', body: 'new' }, params),
    ).toEqual({
      action: 'editPost',
      done: 'saved',
    });
    const edited = await thread(other, post.id);
    expect(edited.post).toMatchObject({ title: 'Mine', edited: true, canEdit: false });
    expect(
      await act(threadActions, 'editComment', member, { commentId: comment!.id, body: '' }, params),
    ).toMatchObject({ status: 400, data: { target: comment!.id, values: { body: '' } } });
  });

  it('AC-BRD-04 an admin edits, pins and deletes anyone’s content through the forms', async () => {
    const post = await insertThread();
    await act(threadActions, 'comment', other, { body: 'first' }, { id: post.id });
    await act(threadActions, 'comment', other, { body: 'second' }, { id: post.id });
    const [first] = await database.db.select().from(comments).orderBy(comments.createdAt);
    const params = { id: post.id };
    expect(await act(threadActions, 'pin', admin, { value: 'true' }, params)).toEqual({
      action: 'pin',
      done: 'pinned',
    });
    expect(
      await act(threadActions, 'deleteComment', admin, { commentId: first!.id }, params),
    ).toEqual({ action: 'deleteComment', done: 'commentDeleted', target: first!.id });
    const data = await thread(member, post.id);
    expect(data.post.isPinned).toBe(true);
    // R-BRD-08: the deleted comment keeps its place because another follows it.
    expect(data.comments.map((row) => row.deleted)).toEqual([true, false]);

    const removed = await act(threadActions, 'deletePost', admin, {}, params);
    expect(removed).toEqual({ redirect: '/discussions', status: 303 });
    await expect(thread(member, post.id)).rejects.toMatchObject({ status: 404 });
  });
});
