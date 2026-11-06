import { describe, expect, it } from 'vitest';
import {
  isAllowedPushEndpoint,
  isValidP256DhKey,
  isValidPushAuthKey,
  validatePushSubscriptionInput,
} from '../../src/lib/server/push';

const VALID_P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const VALID_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

describe('Web Push endpoint allow-list and key validation (R-NTF-02)', () => {
  it('AC-NTF-02 accepts valid https endpoints under configured push hosts and valid keys', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc123',
      'https://jmt17.google.com.fcm.googleapis.com/fcm/send/abc123',
      'https://updates.push.services.mozilla.com/wpush/v2/abc123',
      'https://web.push.apple.com/Qabc123',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true);
      expect(
        validatePushSubscriptionInput({
          endpoint,
          p256dh: VALID_P256DH,
          auth: VALID_AUTH,
        }),
        endpoint,
      ).toBe(true);
    }
  });

  it('AC-NTF-02 refuses http:, ports, credentials, IP literals, look-alike hosts, unlisted hosts and malformed keys', () => {
    const rejectedEndpoints = [
      'http://fcm.googleapis.com/fcm/send/abc123',
      'https://fcm.googleapis.com:8443/fcm/send/abc123',
      'https://fcm.googleapis.com:443/fcm/send/abc123',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc123',
      'https://user@fcm.googleapis.com/fcm/send/abc123',
      'https://127.0.0.1/fcm/send/abc123',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/fcm/send/abc123',
      'https://fcm.googleapis.com.evil.test/fcm/send/abc123',
      'https://evil-fcm.googleapis.com/fcm/send/abc123',
      'https://example.test/push/abc123',
      'https://fcm.googleapis.com/',
      'https://fcm.googleapis.com/fcm/send/abc#frag',
    ];
    for (const endpoint of rejectedEndpoints) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
      expect(
        validatePushSubscriptionInput({
          endpoint,
          p256dh: VALID_P256DH,
          auth: VALID_AUTH,
        }),
        endpoint,
      ).toBe(false);
    }

    // Malformed p256dh: wrong length, wrong prefix, or off-curve point.
    expect(isValidP256DhKey('')).toBe(false);
    expect(isValidP256DhKey('AAAA')).toBe(false);
    // 65 bytes starting with 0x04 but all zeros for x and y (not on P-256 curve).
    const offCurve = new Uint8Array(65);
    offCurve[0] = 0x04;
    const offCurveB64 = Buffer.from(offCurve).toString('base64url');
    expect(isValidP256DhKey(offCurveB64)).toBe(false);

    // Malformed auth: not 16 bytes.
    expect(isValidPushAuthKey('')).toBe(false);
    expect(isValidPushAuthKey('AAAA')).toBe(false);
    expect(isValidPushAuthKey(Buffer.alloc(15).toString('base64url'))).toBe(false);
    expect(isValidPushAuthKey(Buffer.alloc(17).toString('base64url'))).toBe(false);
  });
});
