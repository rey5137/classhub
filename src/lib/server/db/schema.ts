import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// §5.1: UUIDv7 text ids, epoch-millisecond INTEGER timestamps, portable SQLite
// types only. Column names are explicit so the migration and the schema drift
// test see the same names.

const now = () => Date.now();

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    authEmail: text('auth_email').notNull(),
    accessSub: text('access_sub'),
    displayName: text('display_name').notNull(),
    displayNameNorm: text('display_name_norm').notNull(),
    preferredName: text('preferred_name'),
    preferredNameNorm: text('preferred_name_norm'),
    role: text('role', { enum: ['member', 'admin'] })
      .notNull()
      .default('member'),
    status: text('status', { enum: ['invited', 'active', 'suspended'] })
      .notNull()
      .default('invited'),
    avatarMediaId: text('avatar_media_id'),
    deletionRequestedAt: integer('deletion_requested_at', { mode: 'number' }),
    deletionKeepContent: integer('deletion_keep_content', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
    lastSeenAt: integer('last_seen_at', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('users_auth_email_unique').on(table.authEmail),
    check('users_auth_email_lower_check', sql`${table.authEmail} = lower(${table.authEmail})`),
    check('users_role_check', sql`${table.role} in ('member', 'admin')`),
    check('users_status_check', sql`${table.status} in ('invited', 'active', 'suspended')`),
    // R-BUD-01: the admin count reads only the admins, not every member.
    index('users_role_status_idx').on(table.role, table.status),
    index('users_status_display_name_norm_idx').on(table.status, table.displayNameNorm),
    index('users_status_preferred_name_norm_idx').on(table.status, table.preferredNameNorm),
  ],
);

export const profileContacts = sqliteTable('profile_contacts', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  contactEmail: text('contact_email'),
  phone: text('phone'),
  messagingUrl: text('messaging_url'),
  city: text('city'),
  bio: text('bio'),
  visibilityJson: text('visibility_json').notNull().default('{}'),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
});

export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ['member', 'admin'] })
      .notNull()
      .default('member'),
    status: text('status', { enum: ['pending', 'accepted', 'revoked'] })
      .notNull()
      .default('pending'),
    accessSyncedAt: integer('access_synced_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    expiresAt: integer('expires_at', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('invites_email_unique').on(table.email),
    check('invites_email_lower_check', sql`${table.email} = lower(${table.email})`),
    check('invites_role_check', sql`${table.role} in ('member', 'admin')`),
    check('invites_status_check', sql`${table.status} in ('pending', 'accepted', 'revoked')`),
    index('invites_status_email_idx').on(table.status, table.email),
  ],
);

export const infoPages = sqliteTable(
  'info_pages',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
    updatedBy: text('updated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => [
    uniqueIndex('info_pages_slug_unique').on(table.slug),
    // R-BUD-01, R-DB-07: `GET /api/v1/info` and Home's pinned list walk this order without scanning the table.
    index('info_pages_order_idx').on(
      sql`${table.isPinned} desc`,
      table.sortOrder,
      table.title,
      table.id,
    ),
  ],
);

export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    isLocked: integer('is_locked', { mode: 'boolean' }).notNull().default(false),
    commentCount: integer('comment_count', { mode: 'number' }).notNull().default(0),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
    lastActivityAt: integer('last_activity_at', { mode: 'number' }).notNull().$defaultFn(now),
    deletedAt: integer('deleted_at', { mode: 'number' }),
  },
  (table) => [
    index('posts_pinned_activity_idx').on(
      sql`${table.isPinned} desc`,
      sql`${table.lastActivityAt} desc`,
      sql`${table.id} desc`,
    ),
    index('posts_activity_idx').on(sql`${table.lastActivityAt} desc`, sql`${table.id} desc`),
  ],
);

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    bodyMd: text('body_md').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
    deletedAt: integer('deleted_at', { mode: 'number' }),
  },
  (table) => [index('comments_post_idx').on(table.postId, table.createdAt, table.id)],
);

export const albums = sqliteTable(
  'albums',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    yearTag: integer('year_tag', { mode: 'number' }),
    description: text('description'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  // R-BUD-01, R-DB-07: `listAlbumChoices` orders by `(name, id)` with a 50-row limit.
  (table) => [index('albums_name_idx').on(table.name, table.id)],
);

export const media = sqliteTable(
  'media',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    albumId: text('album_id').references(() => albums.id, { onDelete: 'set null' }),
    mediaType: text('media_type', { enum: ['photo', 'avatar', 'site'] }).notNull(),
    objectKey: text('object_key').notNull(),
    thumbKey: text('thumb_key').notNull(),
    mimeType: text('mime_type').notNull(),
    width: integer('width', { mode: 'number' }).notNull(),
    height: integer('height', { mode: 'number' }).notNull(),
    sizeBytes: integer('size_bytes', { mode: 'number' }).notNull(),
    thumbSizeBytes: integer('thumb_size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    thumbSha256: text('thumb_sha256').notNull(),
    caption: text('caption'),
    takenYear: integer('taken_year', { mode: 'number' }),
    effectiveYear: integer('effective_year', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    deletedAt: integer('deleted_at', { mode: 'number' }),
    purgedAt: integer('purged_at', { mode: 'number' }),
  },
  (table) => [
    check('media_media_type_check', sql`${table.mediaType} in ('photo', 'avatar', 'site')`),
    index('media_album_idx').on(table.albumId, sql`${table.createdAt} desc`, sql`${table.id} desc`),
    index('media_owner_idx').on(table.ownerId, table.createdAt),
    index('media_type_deleted_created_idx').on(
      table.mediaType,
      table.deletedAt,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),
    index('media_effective_year_idx').on(
      table.effectiveYear,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),
    index('media_deleted_purged_idx').on(table.deletedAt, table.purgedAt),
  ],
);

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    clientNonce: text('client_nonce').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    editedAt: integer('edited_at', { mode: 'number' }),
    deletedAt: integer('deleted_at', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('chat_messages_sender_nonce_unique').on(table.senderId, table.clientNonce),
    index('chat_messages_room_idx').on(
      table.roomId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),
    index('chat_messages_created_idx').on(table.createdAt),
  ],
);

export const chatArchives = sqliteTable(
  'chat_archives',
  {
    id: text('id').primaryKey(),
    fileName: text('file_name').notNull(),
    fromId: text('from_id').notNull(),
    toId: text('to_id').notNull(),
    rangeStart: integer('range_start', { mode: 'number' }).notNull(),
    rangeEnd: integer('range_end', { mode: 'number' }).notNull(),
    recordCount: integer('record_count', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    exportedAt: integer('exported_at', { mode: 'number' }).notNull(),
    verifiedAt: integer('verified_at', { mode: 'number' }),
    purgedAt: integer('purged_at', { mode: 'number' }),
  },
  (table) => [uniqueIndex('chat_archives_file_name_unique').on(table.fileName)],
);

export const siteSettings = sqliteTable('site_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'restrict' }),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
});

export const storageUsage = sqliteTable(
  'storage_usage',
  {
    singletonId: integer('singleton_id', { mode: 'number' }).primaryKey(),
    committedBytes: integer('committed_bytes', { mode: 'number' }).notNull().default(0),
    reservedBytes: integer('reserved_bytes', { mode: 'number' }).notNull().default(0),
    lastReconciledAt: integer('last_reconciled_at', { mode: 'number' }),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => [check('storage_usage_singleton_id_check', sql`${table.singletonId} = 1`)],
);

/** R-MEM-18: the app's own count of R2 operations, one row per UTC month ('YYYY-MM'). */
export const r2Operations = sqliteTable('r2_operations', {
  month: text('month').primaryKey(),
  classA: integer('class_a', { mode: 'number' }).notNull().default(0),
  classB: integer('class_b', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
});

export const uploadReservations = sqliteTable(
  'upload_reservations',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // R-MEM-09: the media row does not exist when the reservation is created.
    mediaId: text('media_id'),
    purpose: text('purpose', { enum: ['photo', 'avatar', 'site'] }).notNull(),
    reservedBytes: integer('reserved_bytes', { mode: 'number' }).notNull(),
    imageBytes: integer('image_bytes', { mode: 'number' }).notNull(),
    thumbBytes: integer('thumb_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    thumbSha256: text('thumb_sha256').notNull(),
    mimeType: text('mime_type').notNull(),
    objectKey: text('object_key').notNull(),
    thumbKey: text('thumb_key').notNull(),
    state: text('state', {
      enum: ['open', 'completed', 'released'],
    })
      .notNull()
      .default('open'),
    stateRunId: text('state_run_id'),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    width: integer('width', { mode: 'number' }).notNull().default(1),
    height: integer('height', { mode: 'number' }).notNull().default(1),
  },
  (table) => [
    check(
      'upload_reservations_purpose_check',
      sql`${table.purpose} in ('photo', 'avatar', 'site')`,
    ),
    check(
      'upload_reservations_state_check',
      sql`${table.state} in ('open', 'completed', 'released')`,
    ),
    index('upload_reservations_state_idx').on(table.state, table.expiresAt),
    index('upload_reservations_state_run_idx').on(table.stateRunId),
  ],
);

export const rateEvents = sqliteTable(
  'rate_events',
  {
    bucket: text('bucket').notNull(),
    at: integer('at', { mode: 'number' }).notNull(),
  },
  (table) => [index('rate_events_bucket_idx').on(table.bucket, table.at)],
);

// R-AUTH-27..30: pending requests only; approve and reject hard-delete, housekeeping drops them after 30 days.
export const joinRequests = sqliteTable(
  'join_requests',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    note: text('note').notNull().default(''),
    // A salted hash (R-AUTH-29); the raw address is never stored.
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => [
    uniqueIndex('join_requests_email_unique').on(table.email),
    check('join_requests_email_lower_check', sql`${table.email} = lower(${table.email})`),
    index('join_requests_created_idx').on(table.createdAt),
  ],
);

// R-NTF-08: one browser's Web Push subscription; emptied on restore (R-BAK-06).
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    locale: text('locale', { enum: ['vi', 'en'] })
      .notNull()
      .default('vi'),
    deviceLabel: text('device_label').notNull(),
    failureCount: integer('failure_count', { mode: 'number' }).notNull().default(0),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => [
    uniqueIndex('push_subscriptions_endpoint_unique').on(table.endpoint),
    index('push_subscriptions_user_idx').on(table.userId),
  ],
);

// R-NTF-07, 09, 13: per-member notification kinds, mute, chat coalescing and quiet mode.
export const notificationPrefs = sqliteTable(
  'notification_prefs',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    kindsJson: text('kinds_json')
      .notNull()
      .default('{"chat":true,"thread":true,"reply":true,"join":true}'),
    muteUntil: integer('mute_until', { mode: 'number' }),
    lastChatPushAt: integer('last_chat_push_at', { mode: 'number' }).notNull().default(0),
    lastPushAt: integer('last_push_at', { mode: 'number' }).notNull().default(0),
    unseenPushes: integer('unseen_pushes', { mode: 'number' }).notNull().default(0),
    quietSince: integer('quiet_since', { mode: 'number' }),
    summariesSent: integer('summaries_sent', { mode: 'number' }).notNull().default(0),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => [index('notification_prefs_user_idx').on(table.userId)],
);

// R-NTF-07: who gets `reply` pushes for a thread (author and commenters).
export const threadFollowers = sqliteTable(
  'thread_followers',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index('thread_followers_post_idx').on(table.postId),
    index('thread_followers_user_idx').on(table.userId),
  ],
);

export const backupRuns = sqliteTable('backup_runs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  objectCount: integer('object_count', { mode: 'number' }).notNull(),
  totalBytes: integer('total_bytes', { mode: 'number' }).notNull(),
  verifiedAt: integer('verified_at', { mode: 'number' }),
  reportedAt: integer('reported_at', { mode: 'number' }),
});

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
  },
  (table) => [index('audit_events_created_idx').on(table.createdAt)],
);

export const schemaMeta = sqliteTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
