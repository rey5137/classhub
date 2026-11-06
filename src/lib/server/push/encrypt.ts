import { fromBase64Url } from './vapid';

// R-NTF-01: RFC 8291 `aes128gcm` Web Push payload encryption on WebCrypto.

const encoder = new TextEncoder();
const KEY_INFO_PREFIX = encoder.encode('WebPush: info\0');
const CEK_INFO = encoder.encode('Content-Encoding: aes128gcm\0');
const NONCE_INFO = encoder.encode('Content-Encoding: nonce\0');
const DEFAULT_RECORD_SIZE = 4096;

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const arr of arrays) total += arr.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  byteLength: number,
): Promise<Uint8Array> {
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    ikm as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    baseKey,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

export interface EncryptPushSubscription {
  p256dh: string | Uint8Array;
  auth: string | Uint8Array;
}

export interface EncryptPushOptions {
  /** Optional 16-byte salt (used for deterministic RFC 8291 test vectors). */
  salt?: Uint8Array;
  /** Optional ephemeral P-256 ECDH key pair. */
  asKeyPair?: CryptoKeyPair;
  /** Optional pre-derived 32-byte ECDH shared secret + 65-byte AS public key for RFC 8291 test vectors. */
  ecdhSecret?: Uint8Array;
  asPublicKey?: Uint8Array;
  recordSize?: number;
}

function resolveKeyBytes(
  input: string | Uint8Array,
  expectedLength: number,
  label: string,
): Uint8Array {
  const bytes = typeof input === 'string' ? fromBase64Url(input) : input;
  if (!bytes || bytes.length !== expectedLength) {
    throw new Error(`Invalid ${label} length`);
  }
  return bytes;
}

/** R-NTF-01 / AC-NTF-01: encrypts `plaintext` with RFC 8291 `aes128gcm`. */
export async function encryptPushPayload(
  plaintext: Uint8Array | string,
  subscription: EncryptPushSubscription,
  options: EncryptPushOptions = {},
): Promise<Uint8Array> {
  const plainBytes = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext;
  const uaPublic = resolveKeyBytes(subscription.p256dh, 65, 'p256dh');
  const authSecret = resolveKeyBytes(subscription.auth, 16, 'auth');
  const salt = options.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('Invalid salt length');

  let asPublic: Uint8Array;
  let ecdhSecret: Uint8Array;

  if (options.ecdhSecret && options.asPublicKey) {
    if (options.ecdhSecret.length !== 32 || options.asPublicKey.length !== 65) {
      throw new Error('Invalid override key material');
    }
    ecdhSecret = options.ecdhSecret;
    asPublic = options.asPublicKey;
  } else {
    const asKeyPair =
      options.asKeyPair ??
      ((await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
      ])) as CryptoKeyPair);
    const rawAsPub = await globalThis.crypto.subtle.exportKey('raw', asKeyPair.publicKey);
    asPublic = new Uint8Array(rawAsPub);
    const uaCryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      uaPublic as BufferSource,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const sharedBits = await globalThis.crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaCryptoKey },
      asKeyPair.privateKey,
      256,
    );
    ecdhSecret = new Uint8Array(sharedBits);
  }

  // RFC 8291 §3.3: combine ECDH shared secret and auth secret into 32-byte IKM.
  const keyInfo = concatBytes(KEY_INFO_PREFIX, uaPublic, asPublic);
  const ikm = await hkdfSha256(ecdhSecret, authSecret, keyInfo, 32);

  // RFC 8291 §3.4 / RFC 8188 §2.2–2.3: derive 16-byte CEK and 12-byte NONCE.
  const cek = await hkdfSha256(ikm, salt, CEK_INFO, 16);
  const nonce = await hkdfSha256(ikm, salt, NONCE_INFO, 12);

  // RFC 8188 §2: single final record ends with delimiter octet 0x02.
  const paddedPlaintext = concatBytes(plainBytes, new Uint8Array([0x02]));
  const aesKey = await globalThis.crypto.subtle.importKey(
    'raw',
    cek as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ciphertextBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 },
    aesKey,
    paddedPlaintext as BufferSource,
  );
  const ciphertext = new Uint8Array(ciphertextBuf);

  // RFC 8188 §2.1 header: salt (16) || rs (4, big-endian) || idlen (1 = 65) || keyid (65, asPublic).
  const rs = options.recordSize ?? DEFAULT_RECORD_SIZE;
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concatBytes(header, ciphertext);
}
