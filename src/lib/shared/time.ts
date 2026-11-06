import type { Locale } from '../i18n';

const DAY = 86_400_000;

/** R-UI-11: the first-party cookie holding the viewer's IANA time zone, set by the root layout. */
export const TIME_ZONE_COOKIE = 'tz';

const tagOf = (locale: Locale) => (locale === 'vi' ? 'vi-VN' : 'en-GB');

/** True for a zone `Intl` knows; anything else (or a non-string) would throw when formatting. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The cookie's zone when `Intl` knows it, otherwise the site's Level B default. */
export function parseTimeZone(value: string | undefined, fallback: string): string {
  return isTimeZone(value) ? value : fallback;
}

export function timeZoneCookie(timeZone: string, secure: boolean): string {
  return `${TIME_ZONE_COOKIE}=${encodeURIComponent(timeZone)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The calendar day of `at` in `timeZone`, as `YYYY-MM-DD`. */
function dayIn(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/**
 * §3 "running times": a list's short, locale-aware time in the viewer's zone (R-UI-11).
 * Today (that zone's day) shows the clock time, this year the day and month, anything
 * older the full date.
 */
export function shortTime(at: number, locale: Locale, timeZone: string, now = Date.now()): string {
  const tag = tagOf(locale);
  const date = new Date(at);
  const day = dayIn(at, timeZone);
  const today = dayIn(now, timeZone);
  if (now - at < DAY && day === today) {
    return new Intl.DateTimeFormat(tag, { timeZone, hour: '2-digit', minute: '2-digit' }).format(
      date,
    );
  }
  if (day.slice(0, 4) === today.slice(0, 4)) {
    return new Intl.DateTimeFormat(tag, { timeZone, day: 'numeric', month: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat(tag, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/** A full date and time, for a post's or comment's own line and its `<time>` title. */
export function fullTime(at: number, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(tagOf(locale), {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(at));
}

/** A date alone (a photo's day, a member's join date), in the viewer's zone. */
export function mediumDate(at: number | Date, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(tagOf(locale), { timeZone, dateStyle: 'medium' }).format(at);
}
