import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// §5.1: UUIDv7 text ids, epoch-millisecond INTEGER timestamps, portable SQLite
// types only. Column names are explicit so the migration and the schema drift
// test see the same names.

const now = () => Date.now();

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    authEmail: text('auth_email').notNull(),
    displayName: text('display_name').notNull(),
    displayNameNorm: text('display_name_norm').notNull(),
    preferredName: text('preferred_name'),
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
    index('users_status_display_name_norm_idx').on(table.status, table.displayNameNorm),
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
  (table) => [uniqueIndex('info_pages_slug_unique').on(table.slug)],
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

export const albums = sqliteTable('albums', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  yearTag: integer('year_tag', { mode: 'number' }),
  description: text('description'),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
});

export const media = sqliteTable(
  'media',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    albumId: text('album_id').references(() => albums.id, { onDelete: 'set null' }),
    mediaType: text('media_type', { enum: ['photo', 'avatar'] }).notNull(),
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
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    deletedAt: integer('deleted_at', { mode: 'number' }),
  },
  (table) => [
    index('media_album_idx').on(table.albumId, sql`${table.createdAt} desc`, sql`${table.id} desc`),
    index('media_owner_idx').on(table.ownerId, table.createdAt),
    index('media_taken_year_idx').on(
      table.takenYear,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),
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

export const chatArchives = sqliteTable('chat_archives', {
  id: text('id').primaryKey(),
  rangeStart: integer('range_start', { mode: 'number' }).notNull(),
  rangeEnd: integer('range_end', { mode: 'number' }).notNull(),
  recordCount: integer('record_count', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  exportedAt: integer('exported_at', { mode: 'number' }).notNull(),
  verifiedAt: integer('verified_at', { mode: 'number' }),
  purgedAt: integer('purged_at', { mode: 'number' }),
});

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

export const uploadReservations = sqliteTable(
  'upload_reservations',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    mediaId: text('media_id').references(() => media.id, { onDelete: 'set null' }),
    purpose: text('purpose', { enum: ['photo', 'avatar'] }).notNull(),
    reservedBytes: integer('reserved_bytes', { mode: 'number' }).notNull(),
    objectKey: text('object_key').notNull(),
    thumbKey: text('thumb_key').notNull(),
    state: text('state', {
      enum: ['open', 'uploaded', 'completed', 'released'],
    })
      .notNull()
      .default('open'),
    createdAt: integer('created_at', { mode: 'number' }).notNull().$defaultFn(now),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('upload_reservations_state_idx').on(table.state, table.expiresAt)],
);

export const rateEvents = sqliteTable(
  'rate_events',
  {
    bucket: text('bucket').notNull(),
    at: integer('at', { mode: 'number' }).notNull(),
  },
  (table) => [index('rate_events_bucket_idx').on(table.bucket, table.at)],
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
