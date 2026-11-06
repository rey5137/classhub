import { describe, expect, it } from 'vitest';
import {
  fullTime,
  isTimeZone,
  mediumDate,
  parseTimeZone,
  shortTime,
  timeZoneCookie,
} from '../../src/lib/shared/time';

const UTC = 'UTC';
const HCM = 'Asia/Ho_Chi_Minh'; // UTC+7, no daylight saving
const at = (iso: string) => Date.parse(iso);

// §3: list times are short and follow the reader's language and zone (R-UI-10, R-UI-11).
describe('shortTime', () => {
  const now = at('2026-11-06T08:30:00Z'); // 15:30 in Ho Chi Minh City

  it('R-UI-10 shows the clock time today, day and month this year, the full date before', () => {
    expect(shortTime(at('2026-11-06T02:05:00Z'), 'vi', HCM, now)).toBe('09:05');
    expect(shortTime(at('2026-11-05T17:00:00Z'), 'en', HCM, now)).toBe('00:00');
    expect(shortTime(at('2026-11-05T15:00:00Z'), 'en', HCM, now)).toBe('5 Nov');
    expect(shortTime(at('2026-02-03T05:00:00Z'), 'en', HCM, now)).toBe('3 Feb');
    expect(shortTime(at('2024-02-03T05:00:00Z'), 'en', HCM, now)).toBe('03/02/2024');
    expect(shortTime(at('2024-02-03T05:00:00Z'), 'vi', HCM, now)).toBe('03/02/2024');
  });

  it("R-UI-11 the same instant reads in the viewer's zone, and today means that zone's day", () => {
    const instant = at('2026-11-06T02:05:00Z');
    expect(shortTime(instant, 'en', UTC, now)).toBe('02:05');
    expect(shortTime(instant, 'en', HCM, now)).toBe('09:05');
    // 23:30 UTC on the 5th is already 06:30 on the 6th in Ho Chi Minh City: today there,
    // yesterday in UTC.
    const lateEvening = at('2026-11-05T23:30:00Z');
    expect(shortTime(lateEvening, 'en', HCM, now)).toBe('06:30');
    expect(shortTime(lateEvening, 'en', UTC, now)).toBe('5 Nov');
    // Just after midnight in Ho Chi Minh City, 23:59 the evening before is yesterday there.
    const afterMidnight = at('2026-11-05T17:01:00Z'); // 00:01 on the 6th, UTC+7
    expect(shortTime(at('2026-11-05T16:59:00Z'), 'en', HCM, afterMidnight)).toBe('5 Nov');
    expect(shortTime(at('2026-11-05T16:59:00Z'), 'en', UTC, afterMidnight)).toBe('16:59');
    // New Year's Eve evening in UTC is already the next year in Ho Chi Minh City.
    const newYear = at('2026-12-31T20:00:00Z');
    expect(shortTime(at('2026-06-01T05:00:00Z'), 'en', HCM, newYear)).toBe('01/06/2026');
    expect(shortTime(at('2026-06-01T05:00:00Z'), 'en', UTC, newYear)).toBe('1 Jun');
  });
});

describe('fullTime and mediumDate', () => {
  it('R-UI-10 writes a full date and time in either language', () => {
    const instant = at('2026-11-06T02:05:00Z');
    expect(fullTime(instant, 'en', HCM)).toContain('2026');
    expect(fullTime(instant, 'vi', HCM)).toContain('2026');
    expect(fullTime(instant, 'en', HCM)).not.toBe(fullTime(instant, 'vi', HCM));
  });

  it('R-UI-11 renders one instant differently in UTC and Asia/Ho_Chi_Minh', () => {
    const instant = at('2026-11-05T20:00:00Z'); // 03:00 on the 6th, UTC+7
    expect(fullTime(instant, 'en', UTC)).toContain('20:00');
    expect(fullTime(instant, 'en', HCM)).toContain('03:00');
    expect(mediumDate(instant, 'en', UTC)).toBe('5 Nov 2026');
    expect(mediumDate(instant, 'en', HCM)).toBe('6 Nov 2026');
  });
});

describe('R-UI-11 tz cookie', () => {
  it('keeps a zone Intl knows and falls back to the default for anything else', () => {
    expect(parseTimeZone('Europe/Paris', HCM)).toBe('Europe/Paris');
    for (const value of [undefined, '', 'Mars/Olympus', 'x'.repeat(65), '"><script>'])
      expect(parseTimeZone(value, HCM)).toBe(HCM);
    expect(isTimeZone(7)).toBe(false);
  });

  it('writes a year-long first-party cookie and adds Secure only for HTTPS', () => {
    expect(timeZoneCookie('Asia/Ho_Chi_Minh', false)).toBe(
      'tz=Asia%2FHo_Chi_Minh; Path=/; Max-Age=31536000; SameSite=Lax',
    );
    expect(timeZoneCookie('UTC', true)).toBe(
      'tz=UTC; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    );
  });
});
