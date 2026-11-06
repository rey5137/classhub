import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { siteConfig } from '../../config';
import type { AppContext } from '../context';
import { logLine } from '../log';
import type { SiteSettings } from '../../contracts/settings';
import type { Locale } from '../../i18n';
import { notificationPrefs, pushSubscriptions, users } from '../db/schema';
import type { Database } from '../ports/database';
import {
  MAX_PUSH_DELIVERIES_PER_EVENT,
  type PushDeliveryRequest,
  type PushTransport,
} from '../ports/push-transport';
import {
  buildPushHeaders,
  createVapidAuthorization,
  importVapidSigningKey,
  isAllowedPushEndpoint,
  renderPushPayload,
  type PushKind,
  type PushPayload,
  type VapidKeys,
} from '../push';
import {
  getChatPushRecipients,
  getItemPushRecipients,
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

export interface PushServiceContext {
  database: Database;
  push?: PushTransport;
  vapid?: VapidKeys;
  siteOrigin?: string;
  now?: () => number;
  /** Test seam: the per-event delivery ceiling (default 7 batches of 40). */
  maxDeliveriesPerEvent?: number;
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

type ReadyPushContext = PushServiceContext & { push: PushTransport; vapid: VapidKeys };

/**
 * The start every push shares: a transport and keys, the clock, and the site unlocked with
 * notifications and the event's own feature on. Null means send nothing.
 */
async function openPush(
  ctx: PushServiceContext,
  nowInput: number | undefined,
  feature: 'chat' | 'join' | 'discussions',
): Promise<{ ctx: ReadyPushContext; now: number; settings: SiteSettings } | null> {
  if (!hasVapidAndTransport(ctx)) return null;
  const now = nowInput ?? (ctx.now ?? Date.now)();
  const { unlocked, settings } = await resolvePushSiteState(ctx);
  if (!unlocked || !settings.features.notifications || !settings.features[feature]) return null;
  return { ctx, now, settings };
}

type LocalizedPayload = (locale: Locale) => PushPayload;

/** One event's deliveries, collected from the item pushes and the due summaries, sent together. */
interface PushEvent {
  add(
    subscriptions: readonly StoredPushSubscription[],
    payloadForLocale: LocalizedPayload,
    kind: PushKind,
  ): Promise<void>;
  /** Deliveries collected so far. */
  readonly size: number;
  flush(): Promise<void>;
}

/**
 * R-NTF-01, 03, 05, 06: builds one event's deliveries (localized plaintext payload, subscription
 * keys, headers) and hands them to `PushTransport` in a single `send`, so the event stays within
 * its 7 batches whatever mix of pushes and summaries it holds. Encryption happens at delivery;
 * here the VAPID key is imported once and the JWT signed once per push-service audience.
 * `flush` updates `failure_count` and deletes expired rows (R-NTF-06).
 */
function createPushEvent(ctx: ReadyPushContext, now: number): PushEvent {
  const sub = ctx.siteOrigin ?? DEFAULT_SITE_ORIGIN;
  const deliveries: PushDeliveryRequest[] = [];
  const subById = new Map<string, StoredPushSubscription>();
  const authByAudience = new Map<string, string | null>();
  let signingKey: Promise<CryptoKey> | undefined;

  async function authorizationFor(endpoint: string): Promise<string | null> {
    const audience = new URL(endpoint).origin;
    const known = authByAudience.get(audience);
    if (known !== undefined) return known;
    let authorization: string | null = null;
    try {
      signingKey ??= importVapidSigningKey(ctx.vapid.privateKey);
      authorization = await createVapidAuthorization({
        endpoint,
        sub,
        keys: ctx.vapid,
        nowMs: now,
        signingKey: await signingKey,
      });
    } catch {
      // A VAPID key or origin problem is configuration, not a subscription failure (R-NTF-06).
      logLine({ config: 'vapid_sign_failed' });
    }
    authByAudience.set(audience, authorization);
    return authorization;
  }

  return {
    get size() {
      return deliveries.length;
    },
    async add(subscriptions, payloadForLocale, kind) {
      for (const item of subscriptions) {
        // R-NTF-02: re-check endpoint against the allow-list before every send.
        if (!isAllowedPushEndpoint(item.endpoint)) continue;
        const authorization = await authorizationFor(item.endpoint);
        if (!authorization) continue;
        const payload = payloadForLocale(item.locale);
        deliveries.push({
          subscriptionId: item.id,
          endpoint: item.endpoint,
          p256dh: item.p256dh,
          auth: item.auth,
          payload: JSON.stringify(payload),
          headers: buildPushHeaders(kind, payload.tag, authorization),
        });
        subById.set(item.id, item);
      }
    },
    async flush() {
      if (deliveries.length === 0) return;
      const results = await ctx.push.send(deliveries);
      for (const res of results) {
        const stored = subById.get(res.subscriptionId);
        if (stored) {
          await updateFailureCount(ctx.database.db, stored, res.status, now);
        }
      }
    },
  };
}

/**
 * R-NTF-13: claims a quiet member's summary if the doubling interval has passed and returns what
 * to send (or null). The claim advances `summaries_sent` and `last_push_at`.
 */
async function claimSummary(
  ctx: PushServiceContext,
  userId: string,
  now: number,
  settings: SiteSettings,
): Promise<{ subscriptions: StoredPushSubscription[]; payloadForLocale: LocalizedPayload } | null> {
  if (!settings.features.notifications) return null;

  const checked = await sendSummaryCheck(
    ctx.database.db,
    userId,
    now,
    siteConfig.push.summaryHours,
    siteConfig.push.quietAfter,
  );
  if (!checked) return null;

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
  if (subscriptions.length === 0) return null;
  return {
    subscriptions,
    payloadForLocale: (locale) =>
      renderPushPayload({ kind: 'summary', locale, siteName: settings.name, counts }),
  };
}

/** Claims every quiet member's due summary that still fits the event and adds it (after the item pushes). */
async function addDueSummaries(
  ctx: PushServiceContext,
  event: PushEvent,
  quietMembers: readonly { userId: string }[],
  now: number,
  settings: SiteSettings,
): Promise<void> {
  for (const quiet of quietMembers) {
    // A summary the event cannot carry (7 batches of 40) is not claimed, so it stays due.
    if (event.size >= (ctx.maxDeliveriesPerEvent ?? MAX_PUSH_DELIVERIES_PER_EVENT)) break;
    const summary = await claimSummary(ctx, quiet.userId, now, settings);
    if (summary) await event.add(summary.subscriptions, summary.payloadForLocale, 'summary');
  }
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
 * through the summary path, in the same `send` as the chat pushes.
 */
export async function sendChatPush(
  ctx: PushServiceContext,
  input: SendChatPushInput,
): Promise<void> {
  const opened = await openPush(ctx, input.now, 'chat');
  if (!opened) return;
  const { now, settings } = opened;

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

  const event = createPushEvent(opened.ctx, now);
  if (normalRecipientIds.length > 0) {
    const subscriptions = await getSubscriptionsForPush(ctx.database.db, normalRecipientIds);
    await event.add(
      subscriptions,
      (locale) =>
        renderPushPayload({
          kind: 'chat',
          locale,
          sender: input.senderName,
          message: input.messageText,
        }),
      'chat',
    );
  }
  await addDueSummaries(ctx, event, quietMembers, now, settings);
  await event.flush();
}

/**
 * R-NTF-07, 13: sends a join request push to active admins with `join` on and not muted.
 * `join` is never quieted and does not increment `unseen_pushes`.
 */
export async function sendJoinPush(
  ctx: PushServiceContext,
  input: { requestedName: string; now?: number },
): Promise<void> {
  const opened = await openPush(ctx, input.now, 'join');
  if (!opened) return;
  const { now } = opened;

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
  const event = createPushEvent(opened.ctx, now);
  await event.add(
    subscriptions,
    (locale) =>
      renderPushPayload({
        kind: 'join',
        locale,
        requestedName: input.requestedName,
      }),
    'join',
  );
  await event.flush();
}

export interface SendItemPushInput {
  postId: string;
  threadTitle: string;
  actorId: string;
  actorName: string;
  /** `reply`: the thread's author, whose devices go first in the batch (R-NTF-05). */
  priorityUserId?: string;
  /** The comment's text; unused for a new thread. */
  commentText?: string;
  now?: number;
}

/**
 * R-NTF-04, 07, 13: `thread` (a new post, to every recipient) and `reply` (a new comment,
 * to the thread's followers) pushes, after the write committed. Quiet members get
 * the summary path instead of the item.
 */
export async function sendItemPush(
  ctx: PushServiceContext,
  kind: 'thread' | 'reply',
  input: SendItemPushInput,
): Promise<void> {
  const opened = await openPush(ctx, input.now, 'discussions');
  if (!opened) return;
  const { now, settings } = opened;

  const followersOfPostId = kind === 'reply' ? input.postId : undefined;
  const quietAfter = siteConfig.push.quietAfter;
  // Read quiet-mode candidates BEFORE the conditional UPDATE can move a member to the threshold.
  const quietMembers = await getQuietModeRecipients(ctx.database.db, {
    excludeUserIds: [input.actorId],
    kind,
    now,
    quietAfter,
    ...(followersOfPostId ? { followersOfPostId } : {}),
  });
  const recipientIds = await getItemPushRecipients(ctx.database.db, {
    kind,
    actorId: input.actorId,
    now,
    quietAfter,
    ...(followersOfPostId ? { followersOfPostId } : {}),
  });

  const event = createPushEvent(opened.ctx, now);
  if (recipientIds.length > 0) {
    const found = await getSubscriptionsForPush(ctx.database.db, recipientIds);
    // Array.sort is stable: the author's devices first, the rest keep their order.
    const subscriptions = found.sort(
      (a, b) =>
        Number(b.userId === input.priorityUserId) - Number(a.userId === input.priorityUserId),
    );
    await event.add(
      subscriptions,
      (locale) =>
        kind === 'thread'
          ? renderPushPayload({
              kind,
              locale,
              author: input.actorName,
              threadId: input.postId,
              threadTitle: input.threadTitle,
            })
          : renderPushPayload({
              kind,
              locale,
              author: input.actorName,
              postId: input.postId,
              threadTitle: input.threadTitle,
              comment: input.commentText ?? '',
            }),
      kind,
    );
  }
  await addDueSummaries(ctx, event, quietMembers, now, settings);
  await event.flush();
}

/**
 * R-NTF-04: runs a push trigger after the write committed. A failure is logged without any
 * endpoint or key and never reaches the caller. Under `waitUntil` the request does not wait;
 * without one (local dev, tests) the trigger is awaited so a recording transport sees it,
 * except the join push, which is dropped.
 */
export async function pushAfterCommit(
  context: AppContext,
  label: string,
  task: (ctx: PushServiceContext) => Promise<void>,
): Promise<void> {
  if (!context.push || !context.vapid) return;
  // R-AUTH-28: the join push is never awaited inline (the /join reply is uniform), so without a
  // `waitUntil` it is dropped.
  if (label === 'join' && !context.waitUntil) return;
  const work = Promise.resolve()
    .then(() =>
      task({
        database: context.database,
        push: context.push,
        vapid: context.vapid,
        ...(context.siteOrigin ? { siteOrigin: context.siteOrigin } : {}),
      }),
    )
    .catch((err: unknown) =>
      logLine({ pushError: label, errorClass: err instanceof Error ? err.name : 'unknown' }),
    );
  if (context.waitUntil) context.waitUntil(work);
  else await work;
}
