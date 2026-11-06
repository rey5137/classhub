import { CHAT_ROOM_ID } from '../../contracts/chat';
import { DEFAULT_VISIBILITY } from '../../contracts/profile';
import { normalizeName } from '../../shared/normalize';
import { uuidv7 } from '../ids';
import type { Database } from '../ports/database';
import type { ObjectStorage } from '../ports/object-storage';
import { eq, sql } from 'drizzle-orm';
import {
  albums,
  chatMessages,
  comments,
  infoPages,
  invites,
  media,
  posts,
  profileContacts,
  siteSettings,
  storageUsage,
  users,
} from './schema';
import { demoPhoto } from './demo-photos';

interface DemoMember {
  email: string;
  displayName: string;
  preferredName: string | null;
  role: 'member' | 'admin';
}

// Synthetic classmates only (INV-6): reserved example.com addresses, invented
// names, no real person.
const DEMO_MEMBERS: DemoMember[] = [
  { email: 'admin@example.com', displayName: 'An Bui', preferredName: 'An', role: 'admin' },
  {
    email: 'mai.nguyen@example.com',
    displayName: 'Mai Nguyen',
    preferredName: 'Mai',
    role: 'member',
  },
  {
    email: 'linh.tran@example.com',
    displayName: 'Linh Tran',
    preferredName: 'Linh',
    role: 'member',
  },
  { email: 'bao.pham@example.com', displayName: 'Bao Pham', preferredName: 'Bao', role: 'member' },
  { email: 'chi.le@example.com', displayName: 'Chi Le', preferredName: 'Chi', role: 'member' },
  { email: 'duc.vo@example.com', displayName: 'Duc Vo', preferredName: 'Duc', role: 'member' },
  {
    email: 'hanh.dang@example.com',
    displayName: 'Hanh Dang',
    preferredName: 'Hanh',
    role: 'member',
  },
  {
    email: 'khoa.hoang@example.com',
    displayName: 'Khoa Hoang',
    preferredName: 'Khoa',
    role: 'member',
  },
  { email: 'lan.do@example.com', displayName: 'Lan Do', preferredName: 'Lan', role: 'member' },
  { email: 'minh.vu@example.com', displayName: 'Minh Vu', preferredName: 'Minh', role: 'member' },
  { email: 'nga.phan@example.com', displayName: 'Nga Phan', preferredName: 'Nga', role: 'member' },
  {
    email: 'phuc.dinh@example.com',
    displayName: 'Phuc Dinh',
    preferredName: 'Phuc',
    role: 'member',
  },
];

const ADMIN_EMAIL = DEMO_MEMBERS[0]!.email;

// Invented contact details (INV-6) so the directory and member pages show each kind of
// field; the phone numbers are not dialable and the links point at no real account.
const DEMO_CONTACTS: Record<string, { city: string; bio: string; phone?: string; link?: string }> =
  {
    'mai.nguyen@example.com': {
      city: 'Hà Nội',
      bio: 'Still in touch with half the class. Ask me about the reunion.',
      phone: '+84000000001',
      link: 'https://zalo.me/demo-mai',
    },
    'linh.tran@example.com': { city: 'Huế', bio: 'Teaching chemistry now.' },
    'bao.pham@example.com': { city: 'Đà Nẵng', bio: 'Back home after ten years away.' },
    'chi.le@example.com': { city: 'TP. Hồ Chí Minh', bio: 'Photos from every trip.' },
  };

// Invented albums and painted photos (INV-6) so the wall, its filters and a photo page
// have something to show. Each photo names its album by index, or none.
const DEMO_ALBUMS = [
  { name: 'Dã ngoại Ba Vì', yearTag: 2005, description: 'Hai ngày cắm trại cuối năm lớp 11.' },
  { name: 'Chia tay 12A', yearTag: 2007, description: null },
  { name: 'Hội khoẻ Phù Đổng', yearTag: null, description: null },
];
type Rgb = [number, number, number];
const DEMO_PHOTOS: {
  owner: string;
  album: number | null;
  takenYear: number | null;
  caption: string | null;
  sky: Rgb;
  ground: Rgb;
}[] = [
  {
    owner: 'mai.nguyen@example.com',
    album: 0,
    takenYear: null,
    caption: 'Lều xanh bên suối',
    sky: [118, 170, 214],
    ground: [86, 140, 92],
  },
  {
    owner: 'chi.le@example.com',
    album: 0,
    takenYear: null,
    caption: 'Đốt lửa trại',
    sky: [44, 52, 96],
    ground: [190, 96, 54],
  },
  {
    owner: 'bao.pham@example.com',
    album: 0,
    takenYear: null,
    caption: null,
    sky: [150, 196, 230],
    ground: [120, 150, 80],
  },
  {
    owner: 'linh.tran@example.com',
    album: 1,
    takenYear: null,
    caption: 'Ảnh cả lớp trước cổng trường',
    sky: [220, 180, 150],
    ground: [140, 110, 100],
  },
  {
    owner: 'admin@example.com',
    album: 1,
    takenYear: null,
    caption: 'Lưu bút',
    sky: [236, 220, 196],
    ground: [170, 140, 120],
  },
  {
    owner: 'chi.le@example.com',
    album: 1,
    takenYear: null,
    caption: 'Buổi chiều cuối cùng',
    sky: [240, 160, 110],
    ground: [96, 70, 90],
  },
  {
    owner: 'duc.vo@example.com',
    album: 2,
    takenYear: 2006,
    caption: 'Chạy tiếp sức',
    sky: [130, 190, 240],
    ground: [196, 120, 80],
  },
  {
    owner: 'hanh.dang@example.com',
    album: 2,
    takenYear: 2006,
    caption: null,
    sky: [160, 200, 236],
    ground: [96, 150, 96],
  },
  {
    owner: 'minh.vu@example.com',
    album: null,
    takenYear: 2004,
    caption: 'Ngày khai giảng lớp 10',
    sky: [200, 220, 240],
    ground: [150, 130, 110],
  },
  {
    owner: 'mai.nguyen@example.com',
    album: null,
    takenYear: null,
    caption: 'Hồ Tây',
    sky: [110, 150, 200],
    ground: [70, 110, 150],
  },
];

// R-BRD-02: synthetic class info. `reunion` is the page Home shows as the reunion card;
// `ban-can-su` is the pinned page Home lists (R-BRD-01).
const DEMO_INFO = [
  {
    slug: 'reunion',
    title: 'Họp lớp 20 năm',
    bodyMd:
      '**Ngày:** thứ Bảy, 18/7\n\n**Địa điểm:** sân trường cũ, cổng chính\n\n- 17:00 đón khách\n- 18:00 ăn tối\n- 20:00 chụp ảnh chung\n\n[Bản đồ](https://maps.example.com/school)',
    isPinned: true,
    sortOrder: 0,
  },
  {
    slug: 'quy-lop',
    title: 'Quỹ lớp',
    bodyMd:
      'Quỹ lớp dùng cho buổi họp lớp và thăm thầy cô.\n\n1. Đóng góp tuỳ tâm\n2. Thủ quỹ báo cáo mỗi quý\n\n> Cảm ơn cả lớp!',
    isPinned: false,
    sortOrder: 1,
  },
  {
    slug: 'ban-can-su',
    title: 'Ban cán sự lớp',
    bodyMd: 'Lớp trưởng, thủ quỹ và người giữ album. Có việc gì cứ nhắn trong mục Thảo luận.',
    isPinned: true,
    sortOrder: 2,
  },
];

// R-BRD-01, R-BRD-06..08: invented threads (INV-6) so Home, the board and a thread page
// show a pinned and a locked thread, Markdown and a photo reference. `{photo}` is the
// painted "Lều xanh bên suối" photo's id. Comments are by author email, oldest first.
const DEMO_THREADS: {
  author: string;
  title: string;
  bodyMd: string;
  isPinned?: boolean;
  isLocked?: boolean;
  comments: { author: string; bodyMd: string }[];
}[] = [
  {
    author: ADMIN_EMAIL,
    title: 'Đăng ký họp lớp 20 năm',
    bodyMd:
      'Cả lớp ơi, **họp lớp 20 năm** sắp đến rồi.\n\n- Ghi tên ở phần bình luận\n- Báo số người đi cùng\n\nChi tiết ở [trang họp lớp](/info/reunion).',
    isPinned: true,
    comments: [
      { author: 'mai.nguyen@example.com', bodyMd: 'Mình đi, cùng chồng nữa là 2 người.' },
      { author: 'linh.tran@example.com', bodyMd: 'Linh đi một mình nhé.' },
    ],
  },
  {
    author: 'mai.nguyen@example.com',
    title: 'Ai còn giữ ảnh chuyến dã ngoại Ba Vì?',
    bodyMd:
      'Mình tìm được tấm này, ai còn ảnh nào thì *đăng lên* nhé:\n\n[[photo:{photo}]]\n\n1. Ảnh cắm trại\n2. Ảnh đốt lửa trại',
    comments: [
      { author: 'bao.pham@example.com', bodyMd: 'Nhà mình còn một cuộn phim chưa rửa!' },
      { author: ADMIN_EMAIL, bodyMd: 'Rửa xong nhớ đăng vào album **Dã ngoại Ba Vì** nhé.' },
      { author: 'mai.nguyen@example.com', bodyMd: '> cuộn phim chưa rửa\n\nHóng quá Bảo ơi.' },
    ],
  },
  {
    author: 'linh.tran@example.com',
    title: 'Thầy chủ nhiệm giờ ở đâu?',
    bodyMd: 'Có ai còn liên lạc với thầy không? Mình muốn mời thầy đến buổi họp lớp.',
    comments: [{ author: 'bao.pham@example.com', bodyMd: 'Thầy vẫn dạy ở trường cũ đấy.' }],
  },
  {
    author: ADMIN_EMAIL,
    title: 'Nội quy diễn đàn lớp',
    bodyMd: 'Viết lịch sự, không đăng số điện thoại của người khác. Chủ đề này đã khoá.',
    isLocked: true,
    comments: [],
  },
];

/** §9.1: a short room history, oldest first; `deleted` is a tombstone (R-CHAT-03). */
const DEMO_CHAT: { author: string; body: string; deleted?: boolean }[] = [
  {
    author: 'mai.nguyen@example.com',
    body: 'Mọi người chốt giúp mình số người đi họp lớp trước 30/6 nhé.',
  },
  { author: 'linh.tran@example.com', body: 'Mình bay về từ Melbourne, chắc chắn có mặt!' },
  {
    author: 'bao.pham@example.com',
    body: 'Lịch chi tiết ở đây: https://example.test/hop-lop-20-nam',
  },
  { author: ADMIN_EMAIL, body: 'Mình đã ghi tên Linh rồi nhé.' },
  { author: 'mai.nguyen@example.com', body: 'Nhầm nhóm, xin lỗi cả lớp.', deleted: true },
  { author: 'linh.tran@example.com', body: 'Có ai đi chung xe từ Hà Nội không? Mình còn 2 chỗ.' },
  { author: 'bao.pham@example.com', body: 'Cho mình một chỗ với nhé 🚗' },
  {
    author: ADMIN_EMAIL,
    body: 'Chiều nay mình gửi danh sách cuối cùng.\nAi đổi ý thì nhắn trước 17:00.',
  },
];

// D1 caps a statement at 100 bound variables (7 user rows x 13 columns = 91).
const INSERT_CHUNK = 7;

/**
 * @param rows - rows to insert, chunked so the query stays under D1's limit
 * @returns how many rows the inserts actually wrote (conflicts are skipped)
 */
async function insertChunked<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown[]>,
): Promise<number> {
  let inserted = 0;
  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    inserted += (await insert(rows.slice(index, index + INSERT_CHUNK))).length;
  }
  return inserted;
}

/**
 * R-PLAT-10: synthetic classmates and their invites. Idempotent: emails are
 * unique, so a second run inserts nothing. Albums and photos are seeded once, while
 * the first demo album is missing.
 */
export async function seedDemo(
  database: Database,
  storage: ObjectStorage,
): Promise<{ members: number; invites: number; photos: number; threads: number; chat: number }> {
  const now = Date.now();
  const memberRows = DEMO_MEMBERS.map((member) => ({
    id: uuidv7(),
    authEmail: member.email,
    displayName: member.displayName,
    displayNameNorm: normalizeName(member.displayName),
    preferredName: member.preferredName,
    preferredNameNorm: member.preferredName === null ? null : normalizeName(member.preferredName),
    role: member.role,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  }));

  const insertedMembers = await insertChunked(memberRows, (chunk) =>
    database.db.insert(users).values(chunk).onConflictDoNothing().returning({ id: users.id }),
  );

  const stored = await database.db.select({ id: users.id, email: users.authEmail }).from(users);
  const idByEmail = new Map(stored.map((row) => [row.email, row.id]));
  const adminId = idByEmail.get(ADMIN_EMAIL);
  if (!adminId) throw new Error('seedDemo: demo admin is missing');

  const inviteRows = DEMO_MEMBERS.map((member) => ({
    id: uuidv7(),
    email: member.email,
    invitedBy: adminId,
    role: member.role,
    status: 'accepted' as const,
    accessSyncedAt: now,
    createdAt: now,
    expiresAt: null,
  }));

  const insertedInvites = await insertChunked(inviteRows, (chunk) =>
    database.db.insert(invites).values(chunk).onConflictDoNothing().returning({ id: invites.id }),
  );

  const contactRows = Object.entries(DEMO_CONTACTS).flatMap(([email, contact]) => {
    const userId = idByEmail.get(email);
    if (!userId) return [];
    return [
      {
        userId,
        city: contact.city,
        bio: contact.bio,
        phone: contact.phone ?? null,
        messagingUrl: contact.link ?? null,
        visibilityJson: JSON.stringify({
          ...DEFAULT_VISIBILITY,
          city: 'members',
          messaging_url: 'members',
          phone: 'admins',
        }),
        updatedAt: now,
      },
    ];
  });
  await database.db.insert(profileContacts).values(contactRows).onConflictDoNothing();

  // R-PLAT-10: the demo site is open, so `dev:offline` and e2e reach every route; a
  // deployment stays locked until `npm run unlock` (R-AUTH-12). An existing state wins.
  await database.db
    .insert(siteSettings)
    .values({ key: 'setup_state', valueJson: JSON.stringify('unlocked'), updatedAt: now })
    .onConflictDoNothing();

  await database.db
    .insert(infoPages)
    .values(
      DEMO_INFO.map((page) => ({ id: uuidv7(), ...page, updatedBy: adminId, updatedAt: now })),
    )
    .onConflictDoNothing();

  const photos = await seedPhotos(database, storage, idByEmail, now);
  const threads = await seedThreads(database, idByEmail, now);
  const chat = await seedChat(database, idByEmail, now);
  return { members: insertedMembers, invites: insertedInvites, photos, threads, chat };
}

/** Seeded once, while the first demo thread is missing; posts and comments in one batch. */
async function seedThreads(
  database: Database,
  idByEmail: Map<string, string>,
  now: number,
): Promise<number> {
  const [seeded] = await database.db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.title, DEMO_THREADS[0]!.title))
    .limit(1);
  if (seeded) return 0;
  const [photo] = await database.db
    .select({ id: media.id })
    .from(media)
    .where(eq(media.caption, 'Lều xanh bên suối'))
    .limit(1);
  const postRows = [];
  const commentRows = [];
  for (const [index, thread] of DEMO_THREADS.entries()) {
    const id = uuidv7();
    // Older threads first, a day apart; each comment ten minutes after the last.
    const createdAt = now - (DEMO_THREADS.length - index) * 86_400_000;
    const times = thread.comments.map((_, at) => createdAt + (at + 1) * 600_000);
    postRows.push({
      id,
      authorId: idByEmail.get(thread.author)!,
      title: thread.title,
      bodyMd: thread.bodyMd.replace('{photo}', photo?.id ?? '00000000-0000-7000-8000-000000000000'),
      isPinned: thread.isPinned ?? false,
      isLocked: thread.isLocked ?? false,
      commentCount: thread.comments.length,
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: times.at(-1) ?? createdAt,
    });
    for (const [at, comment] of thread.comments.entries()) {
      commentRows.push({
        id: uuidv7(),
        postId: id,
        authorId: idByEmail.get(comment.author)!,
        bodyMd: comment.bodyMd,
        createdAt: times[at]!,
        updatedAt: times[at]!,
      });
    }
  }
  // Under D1's 100 bound variables a statement: 4 posts x 11 and 6 comments x 6 columns.
  await database.batch([
    database.db.insert(posts).values(postRows),
    database.db.insert(comments).values(commentRows),
  ]);
  return postRows.length;
}

async function seedPhotos(
  database: Database,
  storage: ObjectStorage,
  idByEmail: Map<string, string>,
  now: number,
): Promise<number> {
  const [seeded] = await database.db
    .select({ id: albums.id })
    .from(albums)
    .where(eq(albums.name, DEMO_ALBUMS[0]!.name))
    .limit(1);
  if (seeded) return 0;
  const adminId = idByEmail.get(ADMIN_EMAIL)!;
  const albumRows = DEMO_ALBUMS.map((album, index) => ({
    id: uuidv7(),
    ...album,
    createdBy: adminId,
    createdAt: now - (DEMO_ALBUMS.length - index) * 86_400_000,
  }));
  // Objects first, then albums, photos and ledger in one batch: a run that fails
  // part-way writes no rows and removes its objects, so the next run starts clean.
  const written: string[] = [];
  const put = (key: string, bytes: Uint8Array<ArrayBuffer>) => {
    written.push(key);
    return storage.put(key, new Response(bytes).body!, {
      contentType: 'image/jpeg',
      maxBytes: bytes.length,
    });
  };
  const rows = [];
  try {
    for (const [index, photo] of DEMO_PHOTOS.entries()) {
      const id = uuidv7();
      const objectKey = `media/v1/${id}/image.jpg`;
      const thumbKey = `media/v1/${id}/thumb.jpg`;
      const image = await put(objectKey, demoPhoto(1024, 768, photo.sky, photo.ground));
      const thumb = await put(thumbKey, demoPhoto(320, 240, photo.sky, photo.ground));
      const album = photo.album === null ? null : albumRows[photo.album]!;
      rows.push({
        id,
        ownerId: idByEmail.get(photo.owner)!,
        albumId: album?.id ?? null,
        mediaType: 'photo' as const,
        objectKey,
        thumbKey,
        mimeType: 'image/jpeg',
        width: 1024,
        height: 768,
        sizeBytes: image.size,
        thumbSizeBytes: thumb.size,
        sha256: image.sha256,
        thumbSha256: thumb.sha256,
        caption: photo.caption,
        takenYear: photo.takenYear,
        effectiveYear: album?.yearTag ?? photo.takenYear,
        // Oldest first, an hour apart, so the wall's order is stable.
        createdAt: now - (DEMO_PHOTOS.length - index) * 3_600_000,
      });
    }
    const bytes = rows.reduce((sum, row) => sum + row.sizeBytes + row.thumbSizeBytes, 0);
    // R-MEM-15: the ledger counts the seeded bytes like any completed upload.
    await database.batch([
      database.db.insert(albums).values(albumRows),
      database.db
        .update(storageUsage)
        .set({ committedBytes: sql`${storageUsage.committedBytes} + ${bytes}`, updatedAt: now })
        .where(eq(storageUsage.singletonId, 1)),
      ...rows.map((row) => database.db.insert(media).values(row)),
    ]);
  } catch (error) {
    await storage.delete(written).catch(() => undefined);
    throw error;
  }
  return rows.length;
}

/** The demo room's history, seeded once while the room is empty; ten minutes apart, ending an hour ago. */
async function seedChat(
  database: Database,
  idByEmail: Map<string, string>,
  now: number,
): Promise<number> {
  const [any] = await database.db.select({ id: chatMessages.id }).from(chatMessages).limit(1);
  if (any) return 0;
  const start = now - 3_600_000 - DEMO_CHAT.length * 600_000;
  const rows = DEMO_CHAT.flatMap((message, index) => {
    const senderId = idByEmail.get(message.author);
    if (!senderId) return [];
    const createdAt = start + index * 600_000;
    return [
      {
        id: uuidv7(createdAt),
        roomId: CHAT_ROOM_ID,
        senderId,
        clientNonce: uuidv7(createdAt),
        body: message.deleted ? '' : message.body,
        createdAt,
        deletedAt: message.deleted ? createdAt + 60_000 : null,
      },
    ];
  });
  return insertChunked(rows, (chunk) =>
    database.db.insert(chatMessages).values(chunk).returning({ id: chatMessages.id }),
  );
}
