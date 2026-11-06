import { applyD1Migrations, env } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  commentPageSchema,
  liveCommentSchema,
  postItemSchema,
  postPageSchema,
  type CommentItem,
  type PostSummary,
} from '../../src/lib/contracts/discussions';
import { DEFAULT_VISIBILITY } from '../../src/lib/contracts/profile';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import type { Member } from '../../src/lib/server/auth/membership';
import type { AppContext } from '../../src/lib/server/context';
import {
  auditEvents,
  comments,
  media,
  posts,
  profileContacts,
  rateEvents,
  users,
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import {
  buildBoardQuery,
  buildCommentsQuery,
  buildRecentPostsQuery,
  findReferencedPhotos,
  insertComment,
} from '../../src/lib/server/repositories/discussions';
import {
  COMMENTS_PAGE,
  encodeCommentCursor,
  encodePostCursor,
  getThreadWithComments,
  listComments,
  listPosts,
  POSTS_PAGE,
} from '../../src/lib/server/services/discussions';
import { completeDeletion } from '../../src/lib/server/services/members';
import * as commentByIdRoute from '../../src/routes/api/v1/comments/[id]/+server';
import * as postsRoute from '../../src/routes/api/v1/posts/+server';
import * as postByIdRoute from '../../src/routes/api/v1/posts/[id]/+server';
import * as postCommentsRoute from '../../src/routes/api/v1/posts/[id]/comments/+server';
import { seedDeletedMedia } from '../fixtures/housekeeping';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { comparable, createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

type Handler = (event: RequestEvent) => Response | Promise<Response>;
type Module = Record<string, Handler>;

const discussionRoutes: [RegExp, Module][] = [
  [/^\/api\/v1\/posts$/, postsRoute as unknown as Module],
  [/^\/api\/v1\/posts\/(?<id>[^/]+)\/comments$/, postCommentsRoute as unknown as Module],
  [/^\/api\/v1\/posts\/(?<id>[^/]+)$/, postByIdRoute as unknown as Module],
  [/^\/api\/v1\/comments\/(?<id>[^/]+)$/, commentByIdRoute as unknown as Module],
];

async function resolveDiscussionRoute(event: RequestEvent) {
  for (const [pattern, module] of discussionRoutes) {
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
let otherHeaders: Record<string, string>;
let currentTime = 1_800_000_000_000;

const OTHER = {
  id: '01900000-0000-7000-8000-000000000009',
  email: 'other.member@example.test',
};
const viewerMember: Member = {
  id: PEOPLE.active.id,
  displayName: 'Nguyễn Hoạt Động',
  role: 'member',
};

const send = (path: string, method = 'GET', headers = memberHeaders, body?: unknown) =>
  harness.send(path, {
    method,
    headers: {
      ...headers,
      ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  await database.db
    .insert(users)
    .values({
      id: OTHER.id,
      authEmail: OTHER.email,
      displayName: 'Trần Bạn Khác',
      displayNameNorm: 'tran ban khac',
      role: 'member',
      status: 'active',
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoNothing();
  harness = await createHarness(database, {
    resolve: resolveDiscussionRoute,
    now: () => currentTime,
  });
  memberHeaders = await harness.as(PEOPLE.active.email);
  adminHeaders = await harness.as(PEOPLE.admin.email);
  otherHeaders = await harness.as(OTHER.email);
});

beforeEach(async () => {
  currentTime = 1_800_000_000_000;
  await database.db.delete(comments);
  await database.db.delete(posts);
  await database.db.delete(media);
  await database.db.delete(rateEvents);
  await database.db.delete(auditEvents);
});

describe('posts and comments CRUD, lock, moderation, audit and privacy (R-BRD-03..08)', () => {
  it('AC-BRD-03 refuses comments on a locked thread (admins included) without moving counters; unlocking allows them', async () => {
    const createdRes = await send('/api/v1/posts', 'POST', memberHeaders, {
      title: 'Họp lớp 20 năm',
      body: 'Chọn ngày tổ chức họp lớp.',
    });
    expect(createdRes.status).toBe(201);
    const createdPost = postItemSchema.parse(await createdRes.json());
    expect(createdPost.isLocked).toBe(false);
    expect(createdPost.commentCount).toBe(0);

    // First comment on unlocked thread succeeds and bumps commentCount + lastActivityAt.
    const firstCommentRes = await send(
      `/api/v1/posts/${createdPost.id}/comments`,
      'POST',
      otherHeaders,
      { body: 'Mình đăng ký 1 suất nhé!' },
    );
    expect(firstCommentRes.status).toBe(201);
    const firstComment = liveCommentSchema.parse(await firstCommentRes.json());
    expect(firstComment.bodyHtml).toBe('<p>Mình đăng ký 1 suất nhé!</p>');

    const afterFirst = postItemSchema.parse(
      await (await send(`/api/v1/posts/${createdPost.id}`, 'GET', memberHeaders)).json(),
    );
    expect(afterFirst.commentCount).toBe(1);
    expect(afterFirst.lastActivityAt).toBeGreaterThanOrEqual(createdPost.lastActivityAt);

    // Admin locks the thread.
    const lockRes = await send(`/api/v1/posts/${createdPost.id}`, 'PATCH', adminHeaders, {
      isLocked: true,
    });
    expect(lockRes.status).toBe(200);
    const lockedPost = postItemSchema.parse(await lockRes.json());
    expect(lockedPost.isLocked).toBe(true);
    expect(lockedPost.edited).toBe(false);

    // Both member and admin are refused with 423 locked when trying to comment on a locked thread.
    for (const caller of [memberHeaders, adminHeaders]) {
      const refused = await send(`/api/v1/posts/${createdPost.id}/comments`, 'POST', caller, {
        body: 'Cố bình luận khi đã khoá',
      });
      expect(refused.status).toBe(423);
      const err = (await refused.json()) as { error: { code: string; message: string } };
      expect(err.error.code).toBe('locked');
      expect(err.error.message).toMatch(/locked|khoá/i);
    }

    // A race where insertComment runs directly against a locked post also refuses in the SQL statement without changing comment_count.
    expect(
      await insertComment(database, createdPost.id, PEOPLE.active.id, 'Raced comment', currentTime),
    ).toBe('locked');

    const stillLocked = postItemSchema.parse(
      await (await send(`/api/v1/posts/${createdPost.id}`, 'GET', memberHeaders)).json(),
    );
    expect(stillLocked.commentCount).toBe(1);
    expect(stillLocked.lastActivityAt).toBe(afterFirst.lastActivityAt);

    // Admin unlocks the thread; commenting succeeds again.
    const unlockRes = await send(`/api/v1/posts/${createdPost.id}`, 'PATCH', adminHeaders, {
      isLocked: false,
    });
    expect(unlockRes.status).toBe(200);

    const secondCommentRes = await send(
      `/api/v1/posts/${createdPost.id}/comments`,
      'POST',
      adminHeaders,
      { body: 'Đã mở khoá trở lại.' },
    );
    expect(secondCommentRes.status).toBe(201);

    const afterUnlock = postItemSchema.parse(
      await (await send(`/api/v1/posts/${createdPost.id}`, 'GET', memberHeaders)).json(),
    );
    expect(afterUnlock.commentCount).toBe(2);
  });

  it('AC-BRD-04 enforces ownership/admin permissions, uniform denial, soft-delete comment stubs and audit_events without content', async () => {
    const postRes = await send('/api/v1/posts', 'POST', memberHeaders, {
      title: 'Bài của Hoạt Động',
      body: 'Nội dung ban đầu',
    });
    const post = postItemSchema.parse(await postRes.json());
    expect(post.edited).toBe(false);

    // Three comments: c1 (member), c2 (other), c3 (member).
    const c1 = liveCommentSchema.parse(
      await (
        await send(`/api/v1/posts/${post.id}/comments`, 'POST', memberHeaders, {
          body: 'Bình luận 1',
        })
      ).json(),
    );
    const c2 = liveCommentSchema.parse(
      await (
        await send(`/api/v1/posts/${post.id}/comments`, 'POST', otherHeaders, {
          body: 'Bình luận 2',
        })
      ).json(),
    );
    const c3 = liveCommentSchema.parse(
      await (
        await send(`/api/v1/posts/${post.id}/comments`, 'POST', memberHeaders, {
          body: 'Bình luận 3',
        })
      ).json(),
    );

    // Another member cannot edit or delete someone else's post or comment, and cannot pin/lock.
    const forbiddenPostEdit = await send(`/api/v1/posts/${post.id}`, 'PATCH', otherHeaders, {
      title: 'Sửa trộm',
    });
    const forbiddenPin = await send(`/api/v1/posts/${post.id}`, 'PATCH', memberHeaders, {
      isPinned: true,
    });
    const forbiddenLock = await send(`/api/v1/posts/${post.id}`, 'PATCH', memberHeaders, {
      isLocked: true,
    });
    const forbiddenPostDelete = await send(`/api/v1/posts/${post.id}`, 'DELETE', otherHeaders);
    const forbiddenCommentEdit = await send(`/api/v1/comments/${c1.id}`, 'PATCH', otherHeaders, {
      body: 'Sửa trộm bình luận',
    });
    const forbiddenCommentDelete = await send(`/api/v1/comments/${c1.id}`, 'DELETE', otherHeaders);
    const unknownPostGet = await send(`/api/v1/posts/${uuidv7()}`, 'GET', memberHeaders);
    const unknownCommentPatch = await send(`/api/v1/comments/${uuidv7()}`, 'PATCH', memberHeaders, {
      body: 'Không tồn tại',
    });

    for (const res of [
      forbiddenPostEdit,
      forbiddenPin,
      forbiddenLock,
      forbiddenPostDelete,
      forbiddenCommentEdit,
      forbiddenCommentDelete,
      unknownPostGet,
      unknownCommentPatch,
    ]) {
      expect(res.status).toBe(403);
    }
    expect(await comparable(forbiddenPostEdit)).toEqual(await comparable(unknownCommentPatch));

    // Owner edits their own post and comment: `edited` becomes true, `lastActivityAt` does not move, no audit row is written.
    const beforeEdit = postItemSchema.parse(
      await (await send(`/api/v1/posts/${post.id}`, 'GET', memberHeaders)).json(),
    );
    const ownEditRes = await send(`/api/v1/posts/${post.id}`, 'PATCH', memberHeaders, {
      title: 'Bài đã tự sửa',
      body: 'Nội dung **đã tự sửa**',
    });
    expect(ownEditRes.status).toBe(200);
    const ownEditedPost = postItemSchema.parse(await ownEditRes.json());
    expect(ownEditedPost.edited).toBe(true);
    expect(ownEditedPost.lastActivityAt).toBe(beforeEdit.lastActivityAt);
    expect(ownEditedPost.bodyHtml).toBe('<p>Nội dung <strong>đã tự sửa</strong></p>');

    const ownCommentEditRes = await send(`/api/v1/comments/${c1.id}`, 'PATCH', memberHeaders, {
      body: 'Bình luận 1 đã tự sửa',
    });
    expect(ownCommentEditRes.status).toBe(200);
    const ownEditedComment = liveCommentSchema.parse(await ownCommentEditRes.json());
    expect(ownEditedComment.edited).toBe(true);

    // Owner deletes trailing comment c3: omitted from comment list (no later live comment follows), no audit row.
    expect((await send(`/api/v1/comments/${c3.id}`, 'DELETE', memberHeaders)).status).toBe(200);
    expect(await database.db.select().from(auditEvents)).toHaveLength(0);

    let list = commentPageSchema.parse(
      await (await send(`/api/v1/posts/${post.id}/comments`, 'GET', memberHeaders)).json(),
    );
    expect(list.items.map((item) => item.id)).toEqual([c1.id, c2.id]);

    // Admin deletes middle comment c1 (followed by live comment c2): c1 is returned as a `deleted: true` stub without body or author, and an audit row is written.
    expect((await send(`/api/v1/comments/${c1.id}`, 'DELETE', adminHeaders)).status).toBe(200);
    list = commentPageSchema.parse(
      await (await send(`/api/v1/posts/${post.id}/comments`, 'GET', memberHeaders)).json(),
    );
    expect(list.items).toEqual([
      { id: c1.id, postId: post.id, deleted: true, createdAt: c1.createdAt },
      expect.objectContaining({ id: c2.id, deleted: false, bodyMd: 'Bình luận 2' }),
    ]);
    expect(Object.keys(list.items[0]!)).toEqual(['id', 'postId', 'deleted', 'createdAt']);

    // Stored deleted comment has blanked text.
    const [storedC1] = await database.db.select().from(comments).where(eq(comments.id, c1.id));
    expect(storedC1?.bodyMd).toBe('');
    expect(storedC1?.deletedAt).not.toBeNull();

    // Admin edits c2, pins/unpins, locks/unlocks, edits and deletes the post; each writes an audit row without content.
    expect(
      (
        await send(`/api/v1/comments/${c2.id}`, 'PATCH', adminHeaders, {
          body: 'Quản trị sửa bình luận 2',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(`/api/v1/posts/${post.id}`, 'PATCH', adminHeaders, {
          title: 'Quản trị sửa tiêu đề',
          isPinned: true,
          isLocked: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(`/api/v1/posts/${post.id}`, 'PATCH', adminHeaders, {
          isPinned: false,
          isLocked: false,
        })
      ).status,
    ).toBe(200);
    expect((await send(`/api/v1/posts/${post.id}`, 'DELETE', adminHeaders)).status).toBe(200);

    // Deleted post is removed from the board and its GET denies with 403; stored text is blanked.
    expect((await send(`/api/v1/posts/${post.id}`, 'GET', memberHeaders)).status).toBe(403);
    expect(
      postPageSchema.parse(await (await send('/api/v1/posts', 'GET', memberHeaders)).json()).items,
    ).toEqual([]);
    const [storedPost] = await database.db.select().from(posts).where(eq(posts.id, post.id));
    expect(storedPost?.title).toBe('');
    expect(storedPost?.bodyMd).toBe('');
    expect(storedPost?.deletedAt).not.toBeNull();

    const audits = await database.db
      .select()
      .from(auditEvents)
      .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
    expect(audits.map((row) => `${row.entityType}:${row.action}`)).toEqual([
      'comment:comment.delete',
      'comment:comment.edit',
      'post:post.edit',
      'post:post.pin',
      'post:post.lock',
      'post:post.unpin',
      'post:post.unlock',
      'post:post.delete',
    ]);
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain('Quản trị sửa');
    expect(serializedAudits).not.toContain('Bình luận');
  });

  it('AC-AUTH-09 enforces the shared 10/min/member rate limit on post and comment creation while leaving edits unthrottled (R-AUTH-21)', async () => {
    const firstRes = await send('/api/v1/posts', 'POST', memberHeaders, {
      title: 'Bài 1',
      body: 'Nội dung 1',
    });
    expect(firstRes.status).toBe(201);
    const thread = postItemSchema.parse(await firstRes.json());

    // 4 more posts + 5 comments = 10 total creations in the 1-minute window.
    for (let i = 2; i <= 5; i += 1) {
      const res = await send('/api/v1/posts', 'POST', memberHeaders, {
        title: `Bài ${i}`,
        body: `Nội dung ${i}`,
      });
      expect(res.status).toBe(201);
    }
    let lastCommentId = '';
    for (let i = 1; i <= 5; i += 1) {
      const res = await send(`/api/v1/posts/${thread.id}/comments`, 'POST', memberHeaders, {
        body: `Trả lời ${i}`,
      });
      expect(res.status).toBe(201);
      lastCommentId = liveCommentSchema.parse(await res.json()).id;
    }

    // 11th post or comment within the minute is refused with 429 and Retry-After.
    const post429 = await send('/api/v1/posts', 'POST', memberHeaders, {
      title: 'Bài 11',
      body: 'Quá giới hạn',
    });
    expect(post429.status).toBe(429);
    expect(Number(post429.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    const comment429 = await send(`/api/v1/posts/${thread.id}/comments`, 'POST', memberHeaders, {
      body: 'Trả lời 6 quá giới hạn',
    });
    expect(comment429.status).toBe(429);
    expect(Number(comment429.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Edits are not rate limited even while the creation bucket is full.
    expect(
      (
        await send(`/api/v1/posts/${thread.id}`, 'PATCH', memberHeaders, {
          title: 'Bài 1 vẫn sửa được',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(`/api/v1/comments/${lastCommentId}`, 'PATCH', memberHeaders, {
          body: 'Bình luận vẫn sửa được',
        })
      ).status,
    ).toBe(200);

    // Advance the rate-limit window by shifting stored rate_events back 61 seconds.
    await database.db.update(rateEvents).set({ at: Date.now() - 61_000 });
    expect(
      (
        await send(`/api/v1/posts/${thread.id}/comments`, 'POST', memberHeaders, {
          body: 'Sau 1 phút lại gửi được',
        })
      ).status,
    ).toBe(201);
  });

  it('R-BRD-04 renders live, deleted and unknown [[photo:<id>]] references in a single batched lookup and projects authors (R-MEM-20, INV-5)', async () => {
    const livePhoto = await seedDeletedMedia(database, {
      deletedAt: null,
      caption: 'Lửa trại Đà Lạt',
    });
    const deletedPhoto = await seedDeletedMedia(database, {
      deletedAt: currentTime,
      caption: 'Ảnh đã xoá',
    });
    const avatarMedia = await seedDeletedMedia(database, {
      deletedAt: null,
      mediaType: 'avatar',
      caption: 'Ảnh đại diện không phải photo',
    });
    const unknownId = uuidv7();

    // Set OTHER's avatar visibility to 'admins' so members don't see it, admins do.
    await database.db
      .update(users)
      .set({ avatarMediaId: avatarMedia.id })
      .where(eq(users.id, OTHER.id));
    await database.db
      .insert(profileContacts)
      .values({
        userId: OTHER.id,
        visibilityJson: JSON.stringify({ ...DEFAULT_VISIBILITY, avatar_media_id: 'admins' }),
      })
      .onConflictDoUpdate({
        target: profileContacts.userId,
        set: {
          visibilityJson: JSON.stringify({ ...DEFAULT_VISIBILITY, avatar_media_id: 'admins' }),
        },
      });

    try {
      const extraIds = Array.from(
        { length: 10 },
        (_, i) => `01980000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
      );
      const postRes = await send('/api/v1/posts', 'POST', otherHeaders, {
        title: 'Ảnh kỷ niệm',
        body: `Xem **in đậm** [[photo:${livePhoto.id}]] và [[photo:${deletedPhoto.id}]] và [[photo:${avatarMedia.id}]] và [[photo:${unknownId}]] ${extraIds.map((id) => `[[photo:${id}]]`).join(' ')}.`,
      });
      expect(postRes.status).toBe(201);
      const created = postItemSchema.parse(await postRes.json());

      // Board list returns plain-text `excerpt` (syntax and photo tokens stripped, no `bodyHtml`).
      const boardPage = postPageSchema.parse(
        await (await send('/api/v1/posts', 'GET', memberHeaders)).json(),
      );
      expect(boardPage.items[0]?.excerpt).toBe('Xem in đậm và và và .');
      expect('bodyHtml' in boardPage.items[0]!).toBe(false);

      const commentRes = await send(`/api/v1/posts/${created.id}/comments`, 'POST', otherHeaders, {
        body: `Thêm [[photo:${livePhoto.id.toUpperCase()}]] ở bình luận.`,
      });
      expect(commentRes.status).toBe(201);

      // Member view: hides OTHER's admins-only avatar; live photo is an <img>, and the 10-photo cap turns extras into placeholders.
      const asMember = await getThreadWithComments(
        { database } as unknown as AppContext,
        viewerMember,
        { id: created.id },
        {},
        'vi',
      );
      expect(asMember.ok).toBe(true);
      if (!asMember.ok) return;
      expect(asMember.body.post.author.avatarMediaId).toBeUndefined();
      expect(asMember.body.post.bodyHtml).toContain(
        `<a href="/memories/${livePhoto.id}" rel="noopener noreferrer nofollow"><img src="/api/v1/media/${livePhoto.id}/thumb" alt="Lửa trại Đà Lạt"></a>`,
      );
      expect(asMember.body.post.bodyHtml.match(/<em>Ảnh đã gỡ<\/em>/g)).toHaveLength(13);
      const firstComment = asMember.body.comments.items[0]!;
      expect(firstComment.deleted).toBe(false);
      if (!firstComment.deleted) {
        expect(firstComment.bodyHtml).toContain(`/api/v1/media/${livePhoto.id}/thumb`);
      }

      // Admin view: sees OTHER's admins-only avatar.
      const adminGet = postItemSchema.parse(
        await (await send(`/api/v1/posts/${created.id}`, 'GET', adminHeaders)).json(),
      );
      expect(adminGet.author.avatarMediaId).toBe(avatarMedia.id);

      // Over 100 photo IDs are chunked safely under D1's bound-parameter limit.
      const manyIds = [
        livePhoto.id,
        ...Array.from(
          { length: 120 },
          (_, i) => `01990000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
        ),
      ];
      const chunkedMap = await findReferencedPhotos(database, manyIds);
      expect(chunkedMap.size).toBe(1);
      expect(chunkedMap.get(livePhoto.id)?.caption).toBe('Lửa trại Đà Lạt');
    } finally {
      await database.db.delete(profileContacts).where(eq(profileContacts.userId, OTHER.id));
      await database.db.update(users).set({ avatarMediaId: null }).where(eq(users.id, OTHER.id));
    }
  });

  it('R-BRD-08 shows "Former member" for kept posts/comments and blanks deleted ones when a member deletion completes', async () => {
    const tempUserId = '01900000-0000-7000-8000-000000000099';
    await database.db.insert(users).values({
      id: tempUserId,
      authEmail: 'former.test@example.test',
      displayName: 'Phạm Sắp Xoá',
      displayNameNorm: 'pham sap xoa',
      role: 'member',
      status: 'active',
      deletionRequestedAt: currentTime,
      deletionKeepContent: true,
      createdAt: currentTime,
      updatedAt: currentTime,
    });
    const postId = uuidv7(currentTime);
    await database.db.insert(posts).values({
      id: postId,
      authorId: tempUserId,
      title: 'Bài giữ lại',
      bodyMd: 'Nội dung giữ dưới tên Cựu thành viên',
      createdAt: currentTime,
      updatedAt: currentTime,
      lastActivityAt: currentTime,
    });
    const adminMember: Member = {
      id: PEOPLE.admin.id,
      displayName: 'Trần Quản Trị',
      role: 'admin',
    };
    const outcome = await completeDeletion(
      {
        database,
        realtime: {
          async connect() {
            return new Response();
          },
          async disconnectMember() {},
          async notify() {},
        },
      },
      adminMember,
      tempUserId,
      currentTime + 1000,
    );
    expect(outcome.ok).toBe(true);

    const res = await send(`/api/v1/posts/${postId}`, 'GET', memberHeaders);
    expect(res.status).toBe(200);
    const item = postItemSchema.parse(await res.json());
    expect(item.author.displayName).toBe('Cựu thành viên');
    expect(item.author.avatarMediaId).toBeUndefined();
  });
});

describe('query plans and 5,000-row pagination (AC-BRD-02, AC-DB-03, AC-DB-04)', () => {
  it('AC-DB-03 uses indexes with LIMIT and no full table scan over 10,000 seeded posts and comments', async () => {
    const targetPostId = '01900000-0000-7000-8000-000000000001';
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
       insert into posts (id, author_id, title, body_md, is_pinned, is_locked, comment_count,
         created_at, updated_at, last_activity_at, deleted_at)
       select printf('01900000-0000-7000-8000-%012d', i), ?, 'Tiêu đề', 'Nội dung',
         case when i > 9990 then 1 else 0 end, 0, 0,
         ? + i, ? + i, ? + (i % 500), null from n`,
    )
      .bind(PEOPLE.active.id, currentTime, currentTime, currentTime)
      .run();

    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
       insert into comments (id, post_id, author_id, body_md, created_at, updated_at, deleted_at)
       select printf('01910000-0000-7000-8000-%012d', i), ?, ?, 'Bình luận',
         ? + (i % 500), ? + (i % 500), null from n`,
    )
      .bind(targetPostId, PEOPLE.active.id, currentTime, currentTime)
      .run();

    const queries = [
      {
        name: 'board first page',
        query: buildBoardQuery(database, { after: null, limit: POSTS_PAGE }),
        expectedIndex: 'posts_pinned_activity_idx',
      },
      {
        name: 'board cursor page',
        query: buildBoardQuery(database, {
          after: {
            isPinned: false,
            lastActivityAt: currentTime + 250,
            id: '01900000-0000-7000-8000-000000005000',
          },
          limit: POSTS_PAGE,
        }),
        expectedIndex: 'posts_pinned_activity_idx',
      },
      {
        name: 'board without pinned (recent activity)',
        query: buildRecentPostsQuery(database, {
          after: {
            lastActivityAt: currentTime + 250,
            id: '01900000-0000-7000-8000-000000005000',
          },
          limit: POSTS_PAGE,
        }),
        expectedIndex: 'posts_activity_idx',
      },
      {
        name: 'comments list with cursor',
        query: buildCommentsQuery(database, {
          postId: targetPostId,
          after: {
            createdAt: currentTime + 100,
            id: '01910000-0000-7000-8000-000000001000',
          },
          limit: COMMENTS_PAGE,
        }),
        expectedIndex: 'comments_post_idx',
      },
    ];

    for (const { name, query, expectedIndex } of queries) {
      const { sql: sqlText, params } = query.toSQL();
      expect(sqlText.toLowerCase(), `${name} must contain LIMIT`).toContain('limit');
      const planRows = (
        await env.DB.prepare(`explain query plan ${sqlText}`)
          .bind(...params)
          .all<{ detail: string }>()
      ).results;
      const details = planRows.map((row) => row.detail).join(' | ');
      expect(details, `${name} should use ${expectedIndex}: ${details}`).toContain(expectedIndex);
      expect(
        details,
        `${name} must not full-scan a table without an index: ${details}`,
      ).not.toMatch(/\bSCAN\s+\w+(?!\s+USING\s+(?:COVERING\s+)?INDEX)\b/i);
    }
  });

  it('AC-BRD-02, AC-DB-04 pages 5,000 threads (pinned first, equal timestamps) and 5,000 equal-timestamp comments returning every row once', async () => {
    const equalTs = currentTime + 5_000;
    // 5,000 threads: 15 pinned + 4,985 unpinned, all sharing the exact same timestamp `equalTs`
    // so both the pinned->unpinned boundary and equal-timestamp tie-breaking on `id` are proved.
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 5000)
       insert into posts (id, author_id, title, body_md, is_pinned, is_locked, comment_count,
         created_at, updated_at, last_activity_at, deleted_at)
       select printf('01920000-0000-7000-8000-%012d', i), ?, 'Chủ đề', 'Nội dung',
         case when i % 333 = 0 then 1 else 0 end, 0, 0,
         ?, ?, ?, null from n`,
    )
      .bind(PEOPLE.active.id, equalTs, equalTs, equalTs)
      .run();

    const context = { database } as unknown as AppContext;
    const seenPosts: PostSummary[] = [];
    let postCursor: string | undefined;
    let pages = 0;

    do {
      const res = await listPosts(context, viewerMember, postCursor ? { cursor: postCursor } : {});
      expect(res.ok).toBe(true);
      if (!res.ok) break;
      expect(res.body.items.length).toBeLessThanOrEqual(POSTS_PAGE);
      seenPosts.push(...res.body.items);
      postCursor = res.body.nextCursor ?? undefined;
      pages += 1;
    } while (postCursor && pages <= 300);

    expect(seenPosts).toHaveLength(5_000);
    expect(new Set(seenPosts.map((p) => p.id)).size).toBe(5_000);

    // Verify all 15 pinned threads come first in descending id order, followed by all 4,985 unpinned threads in descending id order.
    const firstUnpinnedIdx = seenPosts.findIndex((p) => !p.isPinned);
    expect(firstUnpinnedIdx).toBe(15);
    expect(seenPosts.slice(0, 15).every((p) => p.isPinned)).toBe(true);
    expect(seenPosts.slice(15).every((p) => !p.isPinned)).toBe(true);
    for (let i = 1; i < seenPosts.length; i += 1) {
      const prev = seenPosts[i - 1]!;
      const curr = seenPosts[i]!;
      if (prev.isPinned === curr.isPinned) {
        expect(prev.id > curr.id).toBe(true);
      }
    }

    // 5,000 comments on the first thread, all with the exact same `created_at = equalTs`.
    const threadId = seenPosts[0]!.id;
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 5000)
       insert into comments (id, post_id, author_id, body_md, created_at, updated_at, deleted_at)
       select printf('01930000-0000-7000-8000-%012d', i), ?, ?, 'Phản hồi',
         ?, ?, null from n`,
    )
      .bind(threadId, PEOPLE.active.id, equalTs, equalTs)
      .run();

    const seenComments: CommentItem[] = [];
    let commentCursor: string | undefined;
    let commentPages = 0;

    do {
      const res = await listComments(
        context,
        viewerMember,
        { id: threadId },
        commentCursor ? { cursor: commentCursor } : {},
        'vi',
      );
      expect(res.ok).toBe(true);
      if (!res.ok) break;
      expect(res.body.items.length).toBeLessThanOrEqual(COMMENTS_PAGE);
      seenComments.push(...res.body.items);
      commentCursor = res.body.nextCursor ?? undefined;
      commentPages += 1;
    } while (commentCursor && commentPages <= 300);

    expect(seenComments).toHaveLength(5_000);
    expect(new Set(seenComments.map((c) => c.id)).size).toBe(5_000);
    for (let i = 1; i < seenComments.length; i += 1) {
      expect(seenComments[i - 1]!.id < seenComments[i]!.id).toBe(true);
    }

    // Also verify HTTP route rejects a forged cursor with 400 validation.
    expect((await send('/api/v1/posts?cursor=not-valid', 'GET', memberHeaders)).status).toBe(400);
    expect(
      (await send(`/api/v1/posts/${threadId}/comments?cursor=not-valid`, 'GET', memberHeaders))
        .status,
    ).toBe(400);
    expect(encodePostCursor(seenPosts[0]!)).toEqual(expect.any(String));
    expect(encodeCommentCursor(seenComments[0]!)).toEqual(expect.any(String));
  });
});
