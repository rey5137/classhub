import { describe, expect, it } from 'vitest';
import { RESTORE_CLEAR_PUSH_SUBSCRIPTIONS } from '../../scripts/lib/backup-sql.mjs';
import { generateVapidKeyPair } from '../../scripts/lib/setup.mjs';
import {
  createVapidAuthorization,
  encryptPushPayload,
  fromBase64Url,
  toBase64Url,
  verifyVapidAuthorization,
} from '../../src/lib/server/push';

describe('Web Push VAPID and RFC 8291 encryption (R-NTF-01)', () => {
  it('AC-NTF-01 matches RFC 8291 Appendix A worked example byte for byte', async () => {
    // RFC 8291 §5 / Appendix A test vector inputs.
    const plaintext = 'When I grow up, I want to be a watermelon';
    const uaPrivate = fromBase64Url('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94')!;
    const uaPublic = fromBase64Url(
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    )!;
    const asPublic = fromBase64Url(
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    )!;
    const authSecret = fromBase64Url('BTBZMqHH6r4Tts7J_aSIgg')!;
    const salt = fromBase64Url('DGv6ra1nlYgDCS1FRnbzlw')!;

    // Derive the ECDH shared secret on WebCrypto using RFC 8291's UA private key and AS public key.
    const uaPrivJwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(uaPublic.subarray(1, 33)),
      y: toBase64Url(uaPublic.subarray(33, 65)),
      d: toBase64Url(uaPrivate),
    };
    const uaPrivKey = await globalThis.crypto.subtle.importKey(
      'jwk',
      uaPrivJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const asPubKey = await globalThis.crypto.subtle.importKey(
      'raw',
      asPublic as BufferSource,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const ecdhBits = await globalThis.crypto.subtle.deriveBits(
      { name: 'ECDH', public: asPubKey },
      uaPrivKey,
      256,
    );
    const ecdhSecret = new Uint8Array(ecdhBits);
    expect(toBase64Url(ecdhSecret)).toBe('kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs');

    const body = await encryptPushPayload(
      plaintext,
      { p256dh: uaPublic, auth: authSecret },
      { salt, ecdhSecret, asPublicKey: asPublic, recordSize: 4096 },
    );

    // RFC 8291 §5 expected encrypted body (86-byte header + 42-byte padded plaintext + 16-byte GCM tag).
    const expectedB64Url =
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
    expect(toBase64Url(body)).toBe(expectedB64Url);
    expect(body).toEqual(fromBase64Url(expectedB64Url));
  });

  it('AC-NTF-01 generates a fresh ephemeral key pair and encrypts a valid aes128gcm record', async () => {
    const uaKeyPair = (await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )) as CryptoKeyPair;
    const uaPubRaw = new Uint8Array(
      await globalThis.crypto.subtle.exportKey('raw', uaKeyPair.publicKey),
    );
    const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const encrypted = await encryptPushPayload('{"kind":"chat"}', {
      p256dh: toBase64Url(uaPubRaw),
      auth: toBase64Url(auth),
    });
    expect(encrypted.byteLength).toBe(86 + 15 + 1 + 16);
    expect(encrypted[20]).toBe(65);
    expect(encrypted[21]).toBe(0x04);
  });

  it('AC-NTF-01 signs a VAPID ES256 header that verifies against the public key with aud, exp <= 24 h and sub = site origin', async () => {
    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey'],
    )) as CryptoKeyPair;
    const privateKey = toBase64Url(
      new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
    );
    const publicKey = toBase64Url(
      new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)),
    );
    const nowMs = 1_762_000_000_000;
    const header = await createVapidAuthorization({
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub-token-123',
      sub: 'https://classhub.example.test',
      keys: { publicKey, privateKey },
      nowMs,
    });

    const verified = await verifyVapidAuthorization(header, publicKey, nowMs);
    expect(verified.valid).toBe(true);
    expect(verified.claims?.aud).toBe('https://fcm.googleapis.com');
    expect(verified.claims?.sub).toBe('https://classhub.example.test');
    const nowSec = Math.floor(nowMs / 1000);
    expect(verified.claims!.exp).toBeGreaterThan(nowSec);
    expect(verified.claims!.exp - nowSec).toBeLessThanOrEqual(86_400);

    // Rejects mailto: or path in `sub` (R-NTF-01: site's https:// origin, no email).
    await expect(
      createVapidAuthorization({
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-token-123',
        sub: 'mailto:admin@example.test',
        keys: { publicKey, privateKey },
        nowMs,
      }),
    ).rejects.toThrow();
  });

  it('R-OPS-04 / R-BAK-06: setup generates a valid P-256 VAPID key pair and restore clears push_subscriptions', async () => {
    const generated = await generateVapidKeyPair();
    const pubBytes = fromBase64Url(generated.publicKey);
    expect(pubBytes?.byteLength).toBe(65);
    expect(pubBytes?.[0]).toBe(0x04);

    const header = await createVapidAuthorization({
      endpoint: 'https://web.push.apple.com/Q1234',
      sub: 'https://classhub.example.test',
      keys: generated,
      nowMs: 1_762_000_000_000,
    });
    const verified = await verifyVapidAuthorization(header, generated.publicKey, 1_762_000_000_000);
    expect(verified.valid).toBe(true);
    expect(verified.claims?.aud).toBe('https://web.push.apple.com');

    expect(RESTORE_CLEAR_PUSH_SUBSCRIPTIONS).toBe('DELETE FROM push_subscriptions');
  });
});
