import { z } from 'zod';
import { localeSchema, safeText } from '../config';

// §16: contracts for `/api/v1/notifications` and `/notifications`.

export const notificationKindsSchema = z
  .object({
    chat: z.boolean(),
    thread: z.boolean(),
    reply: z.boolean(),
    join: z.boolean(),
  })
  .strict();

export type NotificationKinds = z.infer<typeof notificationKindsSchema>;

export const DEFAULT_NOTIFICATION_KINDS: NotificationKinds = {
  chat: true,
  thread: true,
  reply: true,
  join: true,
};

export const muteChoices = ['1h', '8h', 'morning', '1w'] as const;
export const muteChoiceSchema = z.enum(muteChoices);
export type MuteChoice = z.infer<typeof muteChoiceSchema>;

export const notificationsPatchSchema = z
  .object({
    kinds: notificationKindsSchema.partial().strict().optional(),
    mute: muteChoiceSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.kinds !== undefined || value.mute !== undefined, {
    message: 'Expected kinds or mute',
  });

export type NotificationsPatch = z.infer<typeof notificationsPatchSchema>;

export const subscriptionPostSchema = z
  .object({
    endpoint: z.string().min(1).max(2048),
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
    locale: localeSchema.optional(),
    deviceLabel: safeText(80).optional(),
  })
  .strict();

export type SubscriptionPostInput = z.infer<typeof subscriptionPostSchema>;

export type DevicePushState = 'on' | 'off' | 'blocked' | 'unsupported' | 'unavailable';

export interface NotificationDeviceView {
  id: string;
  deviceLabel: string;
  createdAt: number;
}

export interface NotificationsView {
  vapidPublicKey: string | null;
  deviceState: DevicePushState;
  kinds: NotificationKinds;
  muteUntil: number | null;
  quiet: boolean;
  devices: NotificationDeviceView[];
}

/** R-NTF-10: derives a human-readable device label from User-Agent without storing the raw UA. */
export function deriveDeviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  let browser = 'Browser';
  if (/EdgA?\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = 'Firefox';
  else if (/CriOS\/|Chrome\//i.test(ua) && !/Chromium\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';

  let os = '';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return os ? `${browser} on ${os}` : browser;
}

function zonedWallParts(
  epochMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function zonedWallAsUtcMs(epochMs: number, timeZone: string): number {
  const p = zonedWallParts(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** R-NTF-09: computes the next 07:00:00.000 in `timeZone` strictly after `nowMs`. */
export function computeNextMorning7Am(nowMs: number, timeZone: string): number {
  const nowParts = zonedWallParts(nowMs, timeZone);
  const advanceDays = nowParts.hour >= 7 ? 1 : 0;
  const targetWallUtc = Date.UTC(
    nowParts.year,
    nowParts.month - 1,
    nowParts.day + advanceDays,
    7,
    0,
    0,
    0,
  );
  // Two-pass offset refinement handles any time zone offset and DST boundary.
  const offset1 = zonedWallAsUtcMs(targetWallUtc, timeZone) - targetWallUtc;
  const guess1 = targetWallUtc - offset1;
  const offset2 = zonedWallAsUtcMs(guess1, timeZone) - guess1;
  return targetWallUtc - offset2;
}

/** R-NTF-09: computes `mute_until` epoch ms from a mute choice, or `null` to unmute. */
export function computeMuteUntil(
  choice: MuteChoice | null,
  nowMs: number,
  timeZone: string,
): number | null {
  if (choice === null) return null;
  switch (choice) {
    case '1h':
      return nowMs + 60 * 60 * 1000;
    case '8h':
      return nowMs + 8 * 60 * 60 * 1000;
    case '1w':
      return nowMs + 7 * 24 * 60 * 60 * 1000;
    case 'morning':
      return computeNextMorning7Am(nowMs, timeZone);
  }
}
