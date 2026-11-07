// R-NTF-10, R-NTF-14: the browser side of turning push on, shared by /notifications and the home card.
import { deriveDeviceLabel } from '../contracts/notifications';
import { extractSubscriptionKeys } from '../install/sw-core';

export const PUSH_CARD_DISMISSED_KEY = 'classhub:push-card-dismissed';
export const PUSH_CARD_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padded = base64String.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const raw = atob(padded + '='.repeat(padLen));
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export async function getPushManager(): Promise<PushManager | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const existingReg = await navigator.serviceWorker.getRegistration?.();
    if (existingReg?.pushManager) return existingReg.pushManager;
    const readyReg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => setTimeout(() => r(null), 1500)),
    ]);
    return readyReg?.pushManager ?? null;
  } catch {
    return null;
  }
}

/** POSTs a browser subscription with the locale and a derived device label; the new row id, or null. */
export async function postSubscription(
  sub: PushSubscription,
  locale: string,
): Promise<string | null> {
  const extracted = extractSubscriptionKeys(sub);
  if (!extracted) return null;
  const res = await fetch('/api/v1/notifications/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...extracted,
      locale,
      deviceLabel: deriveDeviceLabel(navigator.userAgent),
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ?? null;
}

export type TurnOnResult =
  { state: 'on'; id: string } | { state: 'off' | 'blocked' | 'unsupported' | 'failed' };

/** Asks permission (call from a tap only), subscribes and posts the subscription. */
export async function turnOnPush(vapidPublicKey: string, locale: string): Promise<TurnOnResult> {
  if (typeof Notification === 'undefined') return { state: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { state: permission === 'denied' ? 'blocked' : 'off' };
  const pm = await getPushManager();
  if (!pm) return { state: 'unsupported' };
  const existing = await pm.getSubscription();
  const sub =
    existing ??
    (await pm.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));
  const id = await postSubscription(sub, locale);
  return id ? { state: 'on', id } : { state: 'failed' };
}

/**
 * R-NTF-14: the home card shows only in the installed app, where push works on every platform,
 * while this device has never been asked and the card was not dismissed in the last 30 days.
 */
export function pushCardVisible(env: {
  installed: boolean;
  supported: boolean;
  permission: NotificationPermission | null;
  dismissedAt: string | null;
  now: number;
}): boolean {
  if (!env.installed || !env.supported || env.permission !== 'default') return false;
  const at = Number(env.dismissedAt);
  const dismissed =
    env.dismissedAt !== null &&
    Number.isFinite(at) &&
    env.now >= at &&
    env.now - at < PUSH_CARD_DISMISS_MS;
  return !dismissed;
}
