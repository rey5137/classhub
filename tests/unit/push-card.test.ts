import { describe, expect, it } from 'vitest';
import { PUSH_CARD_DISMISS_MS, pushCardVisible } from '../../src/lib/client/push';

// AC-NTF-15 (R-NTF-14)
describe('pushCardVisible', () => {
  const now = 1_800_000_000_000;
  const base = {
    installed: true,
    supported: true,
    permission: 'default' as NotificationPermission,
    dismissedAt: null,
    now,
  };

  it('shows in the installed app before the device was asked', () => {
    expect(pushCardVisible(base)).toBe(true);
  });

  it('never shows in a browser tab or without push support', () => {
    expect(pushCardVisible({ ...base, installed: false })).toBe(false);
    expect(pushCardVisible({ ...base, supported: false })).toBe(false);
    expect(pushCardVisible({ ...base, permission: null })).toBe(false);
  });

  it('hides once the browser has an answer', () => {
    expect(pushCardVisible({ ...base, permission: 'granted' })).toBe(false);
    expect(pushCardVisible({ ...base, permission: 'denied' })).toBe(false);
  });

  it('stays hidden for 30 days after a dismissal, and a damaged value counts as none', () => {
    expect(pushCardVisible({ ...base, dismissedAt: String(now - 1000) })).toBe(false);
    expect(pushCardVisible({ ...base, dismissedAt: String(now - PUSH_CARD_DISMISS_MS) })).toBe(
      true,
    );
    expect(pushCardVisible({ ...base, dismissedAt: String(now + 60_000) })).toBe(true);
    expect(pushCardVisible({ ...base, dismissedAt: 'x' })).toBe(true);
  });
});
