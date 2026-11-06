import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { siteConfig } from '../../config';
import type { SiteSettings } from '../../contracts/settings';
import type { Locale } from '../../i18n';
import { notificationPrefs, pushSubscriptions, users } from '../db/schema';
import type { Database } from '../ports/database';
import type { PushDeliveryRequest, PushTransport } from '../ports/push-transport';
import {
  buildPushHeaders,
  createVapidAuthorization,
  encryptPushPayload,
  isAllowedPushEndpoint,
  renderPushPayload,
  type PushKind,
  type PushPayload,
  type VapidKeys,
} from '../push';
import {
  getChatPushRecipients,
  getQuietModeRecipients,
  readSummaryCounts,
  sendSummaryCheck,
} from '../repositories/notification-prefs';
import {
  getSubscriptionsForPush,
  updateFailureCount,
  type StoredPushSubscription,
} from '../repositories/push-subscriptions';
import { readSettingRows, setupUnlockedIn } from '../repositories/settings';
import { effectiveSettings } from './settings';

// §16.1–16.2: Web Push orchestration, coalesced chat trigger, quiet mode and summaries.

const DEFAULT_SITE_ORIGIN = 'https://classhub.local';
const encoder = new TextEncoder();

export interface PushServiceContext {
  database: Database;
  push?: PushTransport;
  vapid?: VapidKeys;
  siteOrigin?: string;
  now?: () => number;
}

function hasVapidAndTransport(
  ctx: PushServiceContext,
): ctx is PushServiceContext & { push: PushTransport; vapid: VapidKeys } {
  return Boolean(
    ctx.push &&
    ctx.vapid &&
    ctx.vapid.publicKey.trim().length > 0 &&
    ctx.vapid.privateKey.trim().length > 0,
  );
}

async function resolvePushSiteState(
  ctx: PushServiceContext,
): Promise<{ unlocked: boolean; settings: SiteSettings }> {
  const rows = await readSettingRows(ctx.database.db);
  return {
    unlocked: setupUnlockedIn(rows),
    settings: effectiveSettings(rows),
  };
}

/**
 * R-NTF-01, 03, 05, 06: encrypts and VAPID-signs each subscription's localized payload,
 * sends through `PushTransport`, and updates `failure_count` / deletes expired rows.
 */
export async function buildAndSend(
  ctx: PushServiceContext,
  subscriptions: readonly StoredPushSubscription[],
  payloadForLocale: (locale: Locale) => PushPayload,
  kind: PushKind,
  now = (ctx.now ?? Date.now)(),
): Promise<void> {
  if (!hasVapidAndTransport(ctx) || subscriptions.length === 0) return;
  const sub = ctx.siteOrigin ?? DEFAULT_SITE_ORIGIN;

  const deliveries: PushDeliveryRequest[] = [];
  const subById = new Map<string, StoredPushSubscription>();

  for (const item of subscriptions) {
    // R-NTF-02: re-check endpoint against the allow-list before every send.
    if (!isAllowedPushEndpoint(item.endpoint)) continue;
    try {
      const payload = payloadForLocale(item.locale);
      const body = await encryptPushPayload(encoder.encode(JSON.stringify(payload)), {
        p256dh: item.p256dh,
        auth: item.auth,
      });
      const authorization = await createVapidAuthorization({
        endpoint: item.endpoint,
        sub,
        keys: ctx.vapid,
        nowMs: now,
      });
      const headers = buildPushHeaders(kind, payload.tag, authorization);
      deliveries.push({
        subscriptionId: item.id,
        endpoint: item.endpoint,
        headers,
        body,
      });
      subById.set(item.id, item);
    } catch {
      // Malformed stored key material: count as a delivery failure.
      await updateFailureCount(ctx.database.db, item, 400, now);
    }
  }

  if (deliveries.length === 0) return;
  const results = await ctx.push.send(deliveries);
  for (const res of results) {
    const stored = subById.get(res.subscriptionId);
    if (stored) {
      await updateFailureCount(ctx.database.db, stored, res.status, now);
    }
  }
}

/** R-NTF-13: sends a summary push to a quiet member if the doubling interval has passed. */
export async function sendSummaryIfDue(
  ctx: PushServiceContext,
  userId: string,
  now = (ctx.now ?? Date.now)(),
  preloadedSettings?: SiteSettings,
): Promise<boolean> {
  if (!hasVapidAndTransport(ctx)) return false;
  const settings = preloadedSettings ?? (await resolvePushSiteState(ctx)).settings;
  if (!settings.features.notifications) return false;

  const checked = await sendSummaryCheck(
    ctx.database.db,
    userId,
    now,
    siteConfig.push.summaryHours,
    siteConfig.push.quietAfter,
  );
  if (!checked) return false;

  const counts = await readSummaryCounts(
    ctx.database.db,
    userId,
    checked.kinds,
    checked.quietSince ?? 0,
    {
      chat: settings.features.chat,
      discussions: settings.features.discussions,
    },
  );
  const subscriptions = await getSubscriptionsForPush(ctx.database.db, [userId]);
  if (subscriptions.length === 0) return false;

  await buildAndSend(
    ctx,
    subscriptions,
    (locale) =>
      renderPushPayload({
        kind: 'summary',
        locale,
        siteName: settings.name,
        counts,
      }),
    'summary',
    now,
  );
  return true;
}

export interface SendChatPushInput {
  senderId: string;
  senderName: string;
  messageText: string;
  connectedMemberIds: readonly string[];
  now?: number;
}

/**
 * R-NTF-04, 07, 13: sends chat pushes after the room broadcast.
 * Excludes the sender and every member the broadcast reached, coalesces per
 * `push.chatCoalesceSeconds`, and routes quiet members (`unseen_pushes >= quietAfter`)
 * through `sendSummaryIfDue`.
 */
export async function sendChatPush(
  ctx: PushServiceContext,
  input: SendChatPushInput,
): Promise<void> {
  if (!hasVapidAndTransport(ctx)) return;
  const now = input.now ?? (ctx.now ?? Date.now)();
  const { unlocked, settings } = await resolvePushSiteState(ctx);
  if (!unlocked || !settings.features.notifications || !settings.features.chat) return;

  const excludeUserIds = [...new Set([input.senderId, ...input.connectedMemberIds])];
  const coalesceMs = siteConfig.push.chatCoalesceSeconds * 1000;
  const quietAfter = siteConfig.push.quietAfter;

  // Read quiet-mode candidates BEFORE the conditional UPDATE increments unseen_pushes from 9 to 10.
  const quietMembers = await getQuietModeRecipients(ctx.database.db, {
    excludeUserIds,
    kind: 'chat',
    now,
    quietAfter,
  });

  const normalRecipientIds = await getChatPushRecipients(ctx.database.db, {
    excludeUserIds,
    now,
    coalesceMs,
    quietAfter,
  });

  if (normalRecipientIds.length > 0) {
    const subscriptions = await getSubscriptionsForPush(ctx.database.db, normalRecipientIds);
    await buildAndSend(
      ctx,
      subscriptions,
      (locale) =>
        renderPushPayload({
          kind: 'chat',
          locale,
          sender: input.senderName,
          message: input.messageText,
        }),
      'chat',
      now,
    );
  }

  for (const quiet of quietMembers) {
    await sendSummaryIfDue(ctx, quiet.userId, now, settings);
  }
}

/**
 * R-NTF-07, 13: sends a join request push to active admins with `join` on and not muted.
 * `join` is never quieted and does not increment `unseen_pushes`.
 */
export async function sendJoinPush(
  ctx: PushServiceContext,
  input: { requestedName: string; now?: number },
): Promise<void> {
  if (!hasVapidAndTransport(ctx)) return;
  const now = input.now ?? (ctx.now ?? Date.now)();
  const { unlocked, settings } = await resolvePushSiteState(ctx);
  if (!unlocked || !settings.features.notifications || !settings.features.join) return;

  const admins = await ctx.database.db
    .selectDistinct({ userId: users.id })
    .from(users)
    .innerJoin(pushSubscriptions, eq(pushSubscriptions.userId, users.id))
    .leftJoin(notificationPrefs, eq(notificationPrefs.userId, users.id))
    .where(
      and(
        eq(users.status, 'active'),
        eq(users.role, 'admin'),
        or(isNull(notificationPrefs.muteUntil), lte(notificationPrefs.muteUntil, now)),
        sql`coalesce(json_extract(${notificationPrefs.kindsJson}, '$.join'), 1) = 1`,
      ),
    );

  if (admins.length === 0) return;
  const adminIds = admins.map((a) => a.userId);
  const subscriptions = await getSubscriptionsForPush(ctx.database.db, adminIds);
  await buildAndSend(
    ctx,
    subscriptions,
    (locale) =>
      renderPushPayload({
        kind: 'join',
        locale,
        requestedName: input.requestedName,
      }),
    'join',
    now,
  );
}
