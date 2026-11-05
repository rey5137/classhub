import { describe, expect, it } from 'vitest';
import { profilePatchSchema } from '../../src/lib/contracts/profile';
import {
  emailHref,
  normalizeMessagingUrl,
  normalizePhone,
  phoneHref,
} from '../../src/lib/shared/contacts';

const HOSTS = ['zalo.me', 'wa.me', 'm.me', 'messenger.com', 't.me', 'facebook.com', 'line.me'];

describe('contact normalizers (R-PROF-06)', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://zalo.me/0912345678',
    'ftp://zalo.me/x',
    'https://evil.example/zalo.me',
    'https://zalo.me.evil.example/x',
    'https://notzalo.me/x',
    'https://user:pass@zalo.me/x',
    'https://zalo.me@evil.example/x',
    'https://zalo.me:8443/x',
    'vbscript:msgbox',
    `https://zalo.me/${'a'.repeat(300)}`,
    '',
  ])('AC-PROF-04 refuses the messaging URL %j', (input) => {
    expect(normalizeMessagingUrl(input, HOSTS)).toBeNull();
  });

  it.each([
    ['https://zalo.me/0912345678', 'https://zalo.me/0912345678'],
    ['zalo.me/0912345678', 'https://zalo.me/0912345678'],
    ['https://WA.me/84912345678', 'https://wa.me/84912345678'],
    ['https://www.facebook.com/someone', 'https://www.facebook.com/someone'],
    ['  https://t.me/classmate  ', 'https://t.me/classmate'],
  ])('AC-PROF-04 accepts %j as %j', (input, expected) => {
    expect(normalizeMessagingUrl(input, HOSTS)).toBe(expected);
  });

  it('AC-PROF-04 turns a valid phone into E.164 and a tel: link', () => {
    expect(normalizePhone('+84 912 345 678')).toBe('+84912345678');
    expect(phoneHref('+84912345678')).toBe('tel:+84912345678');
    // Not E.164: kept as typed, the link still dials digits only.
    expect(normalizePhone('(028) 3822-1234')).toBe('(028) 3822-1234');
    expect(phoneHref('(028) 3822-1234')).toBe('tel:02838221234');
  });

  it.each(['javascript:1', '12', 'call me', '+84 912 345 678 ext 9', '1'.repeat(33), '+8+4123456'])(
    'AC-PROF-04 refuses the phone %j',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );

  it('AC-PROF-04 turns a valid email into a mailto: link', () => {
    expect(emailHref('mai@example.test')).toBe('mailto:mai@example.test');
  });
});

describe('profilePatchSchema (R-PROF-01, 02, 06)', () => {
  it('AC-PROF-04 refuses javascript:, data: and non-allow-listed links with a field error', () => {
    for (const messagingUrl of [
      'javascript:alert(1)',
      'data:text/html,x',
      'https://evil.example/x',
    ]) {
      const result = profilePatchSchema.safeParse({ messagingUrl });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['messagingUrl']);
    }
    expect(profilePatchSchema.safeParse({ contactEmail: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(profilePatchSchema.safeParse({ phone: 'javascript:1' }).success).toBe(false);
  });

  it('normalizes on parse and clears with an empty value', () => {
    expect(
      profilePatchSchema.parse({
        phone: '+84 912 345 678',
        messagingUrl: 'zalo.me/0912',
        city: '  ',
        bio: null,
        preferredName: ' Mai ',
      }),
    ).toEqual({
      phone: '+84912345678',
      messagingUrl: 'https://zalo.me/0912',
      city: null,
      bio: null,
      preferredName: 'Mai',
    });
  });

  it('refuses control characters, over-long values, unknown keys and bad visibility', () => {
    expect(profilePatchSchema.safeParse({ city: 'Huế\u0007' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ bio: 'line one\nline two' }).success).toBe(true);
    expect(profilePatchSchema.safeParse({ bio: 'x'.repeat(501) }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ displayName: '' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ authEmail: 'me@example.test' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ visibility: { phone: 'everyone' } }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ visibility: { phone: 'admins' } }).success).toBe(true);
  });
});
