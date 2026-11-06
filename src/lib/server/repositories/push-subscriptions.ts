import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { NotificationDeviceView } from '../../contracts/notifications';
import type { Locale } from '../../i18n';
import { notificationPrefs, pushSubscriptions } from '../db/schema';
import { uuidv7 } from '../ids';
import { logLine } from '../log';
import type { Database, DatabaseHandle } from '../ports/database';
import { validatePushSubscriptionInput } from '../push/allow-list';

// R-NTF-02, 06, 08: Web Push subscriptions per device, capped at 5 per member.

export const MAX_SUBSCRIPTIONS_PER_MEMBER = 5;
export const MAX_CONSECUTIVE_PUSH_FAILURES = 5;

export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: Locale;
  deviceLabel: string;
  failureCount: number;
  createdAt: number;
}

export interface UpsertSubscriptionInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: Locale;
  deviceLabel: string;
  now: number;
}

/**
 * R-NTF-02, 08: validates endpoint and keys, moves an existing endpoint to the current
 * member or inserts a new row, and caps the member at 5 subscriptions (replacing oldest).
 */
export async function upsertSubscription(
  database: Database,
  input: UpsertSubscriptionInput,
): Promise<{ ok: true; id: string } | { ok: false; code: 'validation' }> {
  if (
    !validatePushSubscriptionInput({
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    })
  ) {
    return { ok: false, code: 'validation' };
  }

  // Ensure the member has a notification_prefs row so conditional push UPDATEs find them.
  await database.db
    .insert(notificationPrefs)
    .values({ userId: input.userId, updatedAt: input.now })
    .onConflictDoNothing();

  // One statement, so two concurrent POSTs of the same endpoint cannot collide (the second updates).
  // `id` stays with the existing row; a re-post by another member moves it and restarts its `createdAt`.
  const [saved] = await database.db
    .insert(pushSubscriptions)
    .values({
      id: uuidv7(input.now),
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      locale: input.locale,
      deviceLabel: input.deviceLabel,
      failureCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        locale: input.locale,
        deviceLabel: input.deviceLabel,
        failureCount: 0,
        // A moved endpoint is a new device for its new member, so the cap below never trims it first.
        createdAt: sql`CASE WHEN ${pushSubscriptions.userId} <> excluded.user_id THEN excluded.created_at ELSE ${pushSubscriptions.createdAt} END`,
        updatedAt: input.now,
      },
    })
    .returning({ id: pushSubscriptions.id });
  const targetId = saved!.id;

  // R-NTF-08: a member has at most 5 subscriptions; a 6th replaces their oldest.
  const memberSubs = await database.db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, input.userId))
    .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));

  // The row just written is never the one trimmed.
  const others = memberSubs.filter((row) => row.id !== targetId);
  if (others.length > MAX_SUBSCRIPTIONS_PER_MEMBER - 1) {
    const excessIds = others
      .slice(0, others.length - (MAX_SUBSCRIPTIONS_PER_MEMBER - 1))
      .map((row) => row.id);
    await database.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, excessIds));
  }

  return { ok: true, id: targetId };
}

/** R-NTF-08: deletes one of the member's own subscriptions; returns false if missing or another member's. */
export async function deleteSubscription(
  db: DatabaseHandle,
  userId: string,
  subscriptionId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, subscriptionId), eq(pushSubscriptions.userId, userId)))
    .returning({ id: pushSubscriptions.id });
  return deleted.length > 0;
}

/** R-NTF-02, 11: lists only `{ id, deviceLabel, createdAt }` for the member; never endpoints or keys. */
export async function listSubscriptions(
  db: DatabaseHandle,
  userId: string,
): Promise<NotificationDeviceView[]> {
  return db
    .select({
      id: pushSubscriptions.id,
      deviceLabel: pushSubscriptions.deviceLabel,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id));
}

/** R-NTF-05, 08: reads full subscription rows for delivery, capped at 5 per member. */
export async function getSubscriptionsForPush(
  db: DatabaseHandle,
  userIds: readonly string[],
): Promise<StoredPushSubscription[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      locale: pushSubscriptions.locale,
      deviceLabel: pushSubscriptions.deviceLabel,
      failureCount: pushSubscriptions.failureCount,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, [...userIds]))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id));

  const perUser = new Map<string, number>();
  const capped: StoredPushSubscription[] = [];
  for (const row of rows) {
    const count = perUser.get(row.userId) ?? 0;
    if (count >= MAX_SUBSCRIPTIONS_PER_MEMBER) continue;
    perUser.set(row.userId, count + 1);
    capped.push(row);
  }
  return capped;
}

/**
 * R-NTF-06: handles one delivery status.
 * - 2xx: writes nothing unless `failureCount > 0`, which resets `failure_count` to 0.
 * - 404/410: deletes the subscription immediately.
 * - 400/403/413: logs by status only and increments failure count (deletes on 5th consecutive failure).
 * - 429/5xx/network_error: increments failure count (deletes on 5th consecutive failure).
 */
export async function updateFailureCount(
  db: DatabaseHandle,
  subscription: Pick<StoredPushSubscription, 'id' | 'failureCount'>,
  status: number | 'network_error',
  now = Date.now(),
): Promise<void> {
  if (typeof status === 'number' && status >= 200 && status < 300) {
    if (subscription.failureCount > 0) {
      await db
        .update(pushSubscriptions)
        .set({ failureCount: 0, updatedAt: now })
        .where(
          and(eq(pushSubscriptions.id, subscription.id), gt(pushSubscriptions.failureCount, 0)),
        );
    }
    return;
  }

  if (status === 404 || status === 410) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
    return;
  }

  if (status === 400 || status === 403 || status === 413) {
    // R-NTF-02, 06: log by status only; never log endpoint or key.
    logLine({ pushStatus: status });
  }

  const nextFailures = subscription.failureCount + 1;
  if (nextFailures >= MAX_CONSECUTIVE_PUSH_FAILURES) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
    return;
  }

  await db
    .update(pushSubscriptions)
    .set({ failureCount: nextFailures, updatedAt: now })
    .where(eq(pushSubscriptions.id, subscription.id));
}

export async function deleteSubscriptionsByUserId(
  db: DatabaseHandle,
  userId: string,
): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
}
