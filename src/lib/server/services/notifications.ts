import { siteConfig } from '../../config';
import {
  deriveDeviceLabel,
  notificationsPatchSchema,
  subscriptionPostSchema,
  type DevicePushState,
  type NotificationsView,
} from '../../contracts/notifications';
import type { Locale } from '../../i18n';
import type { Member } from '../auth/membership';
import type { AppContext } from '../context';
import { getPrefs, setMute, updateKinds } from '../repositories/notification-prefs';
import {
  deleteSubscription,
  listSubscriptions,
  upsertSubscription,
} from '../repositories/push-subscriptions';
import type { AdminResult } from './admin';

// §16.3: service backing `/api/v1/notifications` and `/notifications`.

export interface NotificationsRequestOptions {
  featureEnabled: boolean;
  timeZone?: string;
  defaultLocale?: Locale;
  userAgent?: string | null;
  now?: number;
}

function hasVapidKeys(context: Pick<AppContext, 'vapid'>): boolean {
  return Boolean(
    context.vapid &&
    context.vapid.publicKey.trim().length > 0 &&
    context.vapid.privateKey.trim().length > 0,
  );
}

/** `GET /api/v1/notifications` and `/notifications` page load. */
export async function getNotifications(
  context: Pick<AppContext, 'database' | 'vapid'>,
  member: Member,
  options: NotificationsRequestOptions,
): Promise<AdminResult<NotificationsView>> {
  if (!options.featureEnabled) return { ok: false, code: 'feature_disabled' };
  const now = options.now ?? Date.now();
  const prefs = await getPrefs(context.database.db, member.id);
  const devices = await listSubscriptions(context.database.db, member.id);
  const available = hasVapidKeys(context);
  const vapidPublicKey = available ? context.vapid!.publicKey : null;
  const deviceState: DevicePushState = !available
    ? 'unavailable'
    : devices.length > 0
      ? 'on'
      : 'off';
  // R-NTF-09: mute ends on its own with no write once `mute_until` passes.
  const muteUntil = prefs.muteUntil !== null && prefs.muteUntil > now ? prefs.muteUntil : null;
  const quiet = prefs.unseenPushes >= siteConfig.push.quietAfter;

  return {
    ok: true,
    status: 200,
    body: {
      vapidPublicKey,
      deviceState,
      kinds: prefs.kinds,
      muteUntil,
      quiet,
      devices,
    },
  };
}

/** `PATCH /api/v1/notifications`: updates kinds or mute choice. */
export async function patchNotifications(
  context: Pick<AppContext, 'database' | 'vapid'>,
  member: Member,
  rawBody: unknown,
  options: NotificationsRequestOptions,
): Promise<AdminResult<NotificationsView>> {
  if (!options.featureEnabled) return { ok: false, code: 'feature_disabled' };
  const parsed = notificationsPatchSchema.safeParse(rawBody);
  if (!parsed.success) return { ok: false, code: 'validation' };
  const now = options.now ?? Date.now();
  const timeZone = options.timeZone ?? siteConfig.timeZone;

  if (parsed.data.kinds) {
    const kindsPatch = { ...parsed.data.kinds };
    if (member.role !== 'admin') {
      delete kindsPatch.join;
    }
    await updateKinds(context.database.db, member.id, kindsPatch, now);
  }

  if (parsed.data.mute !== undefined) {
    await setMute(context.database.db, member.id, parsed.data.mute, timeZone, now);
  }

  return getNotifications(context, member, { ...options, now });
}

/** `POST /api/v1/notifications/subscriptions`: stores or refreshes a device subscription. */
export async function subscribeDevice(
  context: Pick<AppContext, 'database'>,
  member: Member,
  rawBody: unknown,
  options: NotificationsRequestOptions,
): Promise<AdminResult<{ id: string }>> {
  if (!options.featureEnabled) return { ok: false, code: 'feature_disabled' };
  const parsed = subscriptionPostSchema.safeParse(rawBody);
  if (!parsed.success) return { ok: false, code: 'validation' };
  const now = options.now ?? Date.now();
  const locale = parsed.data.locale ?? options.defaultLocale ?? siteConfig.locale;
  const deviceLabel = parsed.data.deviceLabel ?? deriveDeviceLabel(options.userAgent);

  const saved = await upsertSubscription(context.database, {
    userId: member.id,
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.p256dh,
    auth: parsed.data.auth,
    locale,
    deviceLabel,
    now,
  });
  if (!saved.ok) return { ok: false, code: 'validation' };

  return { ok: true, status: 201, body: { id: saved.id } };
}

/** `DELETE /api/v1/notifications/subscriptions/:id`: removes one of the member's own devices. */
export async function unsubscribeDevice(
  context: Pick<AppContext, 'database'>,
  member: Member,
  subscriptionId: string,
  options: NotificationsRequestOptions,
): Promise<AdminResult<{ ok: true }>> {
  if (!options.featureEnabled) return { ok: false, code: 'feature_disabled' };
  if (!subscriptionId) return { ok: false, code: 'not_found' };
  const removed = await deleteSubscription(context.database.db, member.id, subscriptionId);
  if (!removed) return { ok: false, code: 'not_found' };
  return { ok: true, status: 200, body: { ok: true } };
}
