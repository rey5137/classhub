import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  computeMuteUntil,
  DEFAULT_NOTIFICATION_KINDS,
  notificationKindsSchema,
  type MuteChoice,
  type NotificationKinds,
} from '../../contracts/notifications';
import { SEAT_LIMIT } from '../../shared/seats';
import {
  chatMessages,
  comments,
  notificationPrefs,
  posts,
  pushSubscriptions,
  threadFollowers,
  users,
} from '../db/schema';
import type { DatabaseHandle } from '../ports/database';

// R-NTF-07, 09, 13: per-member kinds, temporary mute, chat coalescing and quiet mode.

export interface StoredNotificationPrefs {
  userId: string;
  kinds: NotificationKinds;
  muteUntil: number | null;
  lastChatPushAt: number;
  lastPushAt: number;
  unseenPushes: number;
  quietSince: number | null;
  summariesSent: number;
  updatedAt: number;
}

export function parseNotificationKinds(raw: string | null | undefined): NotificationKinds {
  if (!raw) return { ...DEFAULT_NOTIFICATION_KINDS };
  try {
    const parsed = notificationKindsSchema.partial().safeParse(JSON.parse(raw));
    if (!parsed.success) return { ...DEFAULT_NOTIFICATION_KINDS };
    return { ...DEFAULT_NOTIFICATION_KINDS, ...parsed.data };
  } catch {
    return { ...DEFAULT_NOTIFICATION_KINDS };
  }
}

function toStoredPrefs(
  userId: string,
  row: typeof notificationPrefs.$inferSelect | undefined,
): StoredNotificationPrefs {
  if (!row) {
    return {
      userId,
      kinds: { ...DEFAULT_NOTIFICATION_KINDS },
      muteUntil: null,
      lastChatPushAt: 0,
      lastPushAt: 0,
      unseenPushes: 0,
      quietSince: null,
      summariesSent: 0,
      updatedAt: 0,
    };
  }
  return {
    userId: row.userId,
    kinds: parseNotificationKinds(row.kindsJson),
    muteUntil: row.muteUntil,
    lastChatPushAt: row.lastChatPushAt,
    lastPushAt: row.lastPushAt,
    unseenPushes: row.unseenPushes,
    quietSince: row.quietSince,
    summariesSent: row.summariesSent,
    updatedAt: row.updatedAt,
  };
}

/** Reads a member's notification preferences, returning defaults when no row exists yet. */
export async function getPrefs(
  db: DatabaseHandle,
  userId: string,
): Promise<StoredNotificationPrefs> {
  const rows = await db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
    .limit(1);
  return toStoredPrefs(userId, rows[0]);
}

/** Upserts a default preferences row for `userId` and returns the stored preferences. */
export async function getOrCreatePrefs(
  db: DatabaseHandle,
  userId: string,
  now = Date.now(),
): Promise<StoredNotificationPrefs> {
  await db.insert(notificationPrefs).values({ userId, updatedAt: now }).onConflictDoNothing();
  return getPrefs(db, userId);
}

/** R-NTF-07: merges `patch` into the member's `kinds_json` and saves the row. */
export async function updateKinds(
  db: DatabaseHandle,
  userId: string,
  patch: Partial<NotificationKinds>,
  now = Date.now(),
): Promise<StoredNotificationPrefs> {
  const current = await getPrefs(db, userId);
  const nextKinds: NotificationKinds = { ...current.kinds, ...patch };
  const kindsJson = JSON.stringify(nextKinds);
  await db
    .insert(notificationPrefs)
    .values({ userId, kindsJson, updatedAt: now })
    .onConflictDoUpdate({
      target: notificationPrefs.userId,
      set: { kindsJson, updatedAt: now },
    });
  return getPrefs(db, userId);
}

/** R-NTF-09: computes `mute_until` from the choice and time zone (or NULL to unmute). */
export async function setMute(
  db: DatabaseHandle,
  userId: string,
  choice: MuteChoice | null,
  timeZone: string,
  now = Date.now(),
): Promise<StoredNotificationPrefs> {
  const muteUntil = computeMuteUntil(choice, now, timeZone);
  await db
    .insert(notificationPrefs)
    .values({ userId, muteUntil, updatedAt: now })
    .onConflictDoUpdate({
      target: notificationPrefs.userId,
      set: { muteUntil, updatedAt: now },
    });
  return getPrefs(db, userId);
}

/**
 * R-NTF-07: single conditional `UPDATE notification_prefs ... RETURNING user_id` for chat pushes.
 * Excludes the sender and connected members, requires active status, at least one subscription,
 * `chat` kind on, not muted, not quiet (`unseen_pushes < quietAfter`), and outside the coalesce window.
 */
export async function getChatPushRecipients(
  db: DatabaseHandle,
  options: {
    excludeUserIds: readonly string[];
    now: number;
    coalesceMs: number;
    quietAfter: number;
  },
): Promise<string[]> {
  const { excludeUserIds, now, coalesceMs, quietAfter } = options;
  const windowCutoff = now - coalesceMs;

  // Ensure every subscribed active user has a prefs row so the single conditional UPDATE covers them.
  const subscribedUsers = await db
    .selectDistinct({ userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .innerJoin(users, eq(users.id, pushSubscriptions.userId))
    .where(
      and(
        eq(users.status, 'active'),
        excludeUserIds.length > 0
          ? sql`${users.id} NOT IN (${sql.join(
              excludeUserIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : undefined,
      ),
    )
    .limit(SEAT_LIMIT);

  if (subscribedUsers.length === 0) return [];
  const candidateIds = subscribedUsers.map((r) => r.userId);

  await db
    .insert(notificationPrefs)
    .values(candidateIds.map((userId) => ({ userId, updatedAt: now })))
    .onConflictDoNothing();

  const updated = await db
    .update(notificationPrefs)
    .set({
      lastChatPushAt: now,
      lastPushAt: now,
      unseenPushes: sql`${notificationPrefs.unseenPushes} + 1`,
      quietSince: sql`CASE WHEN ${notificationPrefs.unseenPushes} + 1 >= ${quietAfter} AND ${notificationPrefs.quietSince} IS NULL THEN ${now} ELSE ${notificationPrefs.quietSince} END`,
      updatedAt: now,
    })
    .where(
      and(
        inArray(notificationPrefs.userId, candidateIds),
        or(isNull(notificationPrefs.muteUntil), lte(notificationPrefs.muteUntil, now)),
        sql`coalesce(json_extract(${notificationPrefs.kindsJson}, '$.chat'), 1) = 1`,
        sql`${notificationPrefs.unseenPushes} < ${quietAfter}`,
        or(
          eq(notificationPrefs.lastChatPushAt, 0),
          lte(notificationPrefs.lastChatPushAt, windowCutoff),
        ),
        sql`exists (select 1 from ${users} where ${users.id} = ${notificationPrefs.userId} and ${users.status} = 'active')`,
        sql`exists (select 1 from ${pushSubscriptions} where ${pushSubscriptions.userId} = ${notificationPrefs.userId})`,
      ),
    )
    .returning({ userId: notificationPrefs.userId });

  return updated.map((row) => row.userId);
}

/** R-NTF-13: finds active, non-muted subscribed candidates who are in quiet mode (`unseen_pushes >= quietAfter`). */
export async function getQuietModeRecipients(
  db: DatabaseHandle,
  options: {
    excludeUserIds: readonly string[];
    kind: 'chat' | 'thread' | 'reply';
    now: number;
    quietAfter: number;
  },
): Promise<StoredNotificationPrefs[]> {
  const { excludeUserIds, kind, now, quietAfter } = options;
  const rows = await db
    .select({ prefs: notificationPrefs })
    .from(notificationPrefs)
    .innerJoin(users, eq(users.id, notificationPrefs.userId))
    .where(
      and(
        eq(users.status, 'active'),
        excludeUserIds.length > 0
          ? sql`${notificationPrefs.userId} NOT IN (${sql.join(
              excludeUserIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : undefined,
        or(isNull(notificationPrefs.muteUntil), lte(notificationPrefs.muteUntil, now)),
        sql`coalesce(json_extract(${notificationPrefs.kindsJson}, ${`$.${kind}`}), 1) = 1`,
        sql`${notificationPrefs.unseenPushes} >= ${quietAfter}`,
        sql`exists (select 1 from ${pushSubscriptions} where ${pushSubscriptions.userId} = ${notificationPrefs.userId})`,
      ),
    )
    .limit(SEAT_LIMIT);

  return rows.map((r) => toStoredPrefs(r.prefs.userId, r.prefs));
}

/** R-NTF-13: computes the summary interval in ms (6 h -> 12 h -> 24 h, then daily). */
export function summaryIntervalMs(summariesSent: number, baseHours: number): number {
  const hours = Math.min(24, baseHours * Math.pow(2, Math.max(0, summariesSent)));
  return hours * 60 * 60 * 1000;
}

/**
 * R-NTF-13: conditional check and update for sending a quiet-mode summary.
 * Wait-free on first summary after entering quiet mode (`summaries_sent = 0` and event arrives after quiet threshold,
 * or after `summaryIntervalMs` has elapsed since `last_push_at`).
 */
export async function sendSummaryCheck(
  db: DatabaseHandle,
  userId: string,
  now: number,
  baseSummaryHours: number,
  quietAfter: number,
): Promise<StoredNotificationPrefs | null> {
  const current = await getPrefs(db, userId);
  if (current.unseenPushes < quietAfter) return null;

  // R-NTF-13 / AC-NTF-14: after 10 unseen pushes, the next event sends one summary (`summariesSent === 0`),
  // and subsequent summaries come no sooner than 6 h, then 12 h, then 24 h since the last push.
  const requiredIntervalMs =
    current.summariesSent === 0
      ? 0
      : summaryIntervalMs(current.summariesSent - 1, baseSummaryHours);
  const cutoff = now - requiredIntervalMs;

  const updated = await db
    .update(notificationPrefs)
    .set({
      lastPushAt: now,
      summariesSent: sql`${notificationPrefs.summariesSent} + 1`,
      quietSince: sql`coalesce(${notificationPrefs.quietSince}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(notificationPrefs.userId, userId),
        eq(notificationPrefs.summariesSent, current.summariesSent),
        sql`${notificationPrefs.unseenPushes} >= ${quietAfter}`,
        lte(notificationPrefs.lastPushAt, cutoff),
      ),
    )
    .returning();

  if (!updated[0]) return null;
  return toStoredPrefs(userId, updated[0]);
}

/** R-NTF-13: reads activity counts since `quietSince` for the member's enabled kinds (each LIMIT 100). */
export async function readSummaryCounts(
  db: DatabaseHandle,
  userId: string,
  kinds: NotificationKinds,
  sinceMs: number,
  enabledFeatures: { chat: boolean; discussions: boolean },
): Promise<{ chat?: number; thread?: number; reply?: number }> {
  const counts: { chat?: number; thread?: number; reply?: number } = {};

  if (kinds.chat && enabledFeatures.chat) {
    const rows = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          sql`${chatMessages.createdAt} >= ${sinceMs}`,
          isNull(chatMessages.deletedAt),
          ne(chatMessages.senderId, userId),
        ),
      )
      .orderBy(sql`${chatMessages.createdAt} DESC`)
      .limit(100);
    counts.chat = rows.length;
  }

  if (kinds.thread && enabledFeatures.discussions) {
    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          sql`${posts.createdAt} >= ${sinceMs}`,
          isNull(posts.deletedAt),
          ne(posts.authorId, userId),
        ),
      )
      .orderBy(sql`${posts.createdAt} DESC`)
      .limit(100);
    counts.thread = rows.length;
  }

  if (kinds.reply && enabledFeatures.discussions) {
    const rows = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          sql`${comments.createdAt} >= ${sinceMs}`,
          isNull(comments.deletedAt),
          ne(comments.authorId, userId),
        ),
      )
      .orderBy(sql`${comments.createdAt} DESC`)
      .limit(100);
    counts.reply = rows.length;
  }

  return counts;
}

/**
 * R-NTF-13: resets `unseen_pushes`, `quiet_since`, and `summaries_sent` when the member opens the app.
 * Guarded by `unseen_pushes > 0` so no write happens when already 0.
 */
export async function resetUnseenPushes(
  db: DatabaseHandle,
  userId: string,
  now = Date.now(),
): Promise<void> {
  await db
    .update(notificationPrefs)
    .set({
      unseenPushes: 0,
      quietSince: null,
      summariesSent: 0,
      updatedAt: now,
    })
    .where(and(eq(notificationPrefs.userId, userId), gt(notificationPrefs.unseenPushes, 0)));
}

export async function deletePrefsByUserId(db: DatabaseHandle, userId: string): Promise<void> {
  await db.delete(notificationPrefs).where(eq(notificationPrefs.userId, userId));
  await db.delete(threadFollowers).where(eq(threadFollowers.userId, userId));
}
