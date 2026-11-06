import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Encoded } from '../../src/lib/client/image/encode';
import { failureOf, setAvatar, uploadEncoded, UploadError } from '../../src/lib/client/upload';

// §7.2 driven from the browser: the call order, and the release after any failure
// once a reservation exists (R-MEM-10).

const RESERVATION = '01900000-0000-7000-8000-00000000c001';
const MEDIA = '01900000-0000-7000-8000-00000000d001';

const encoded = (thumb = true): Encoded => ({
  image: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  thumb: thumb ? new Blob([new Uint8Array(100)], { type: 'image/webp' }) : null,
  mimeType: 'image/webp',
  width: 2000,
  height: 1500,
  sha256: 'a'.repeat(64),
  thumbSha256: 'b'.repeat(64),
});

type Answer = Response | Error;

/** Answers each request by `METHOD path`, recording the calls in order. */
function server(answers: Record<string, Answer>) {
  const calls: { key: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, init });
    const answer = answers[key] ?? new Response('{}', { status: 200 });
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const failure = (status: number) => new Response('{"error":{}}', { status });

const base = '/api/v1/media/reservations';
const happy = {
  [`POST ${base}`]: ok({ id: RESERVATION, mediaId: MEDIA, expiresAt: 1 }, 201),
  [`POST ${base}/${RESERVATION}/complete`]: ok({ id: MEDIA }, 201),
};

afterEach(() => vi.unstubAllGlobals());

describe('R-MEM-06..09 the client protocol', () => {
  it('reserves with the encoded sizes and hashes, puts both variants, then completes', async () => {
    const calls = server(happy);
    const progress = vi.fn();
    const id = await uploadEncoded(
      encoded(),
      'photo',
      { caption: 'Lớp mình', takenYear: 2004 },
      progress,
    );
    expect(id).toBe(MEDIA);
    expect(calls.map((call) => call.key)).toEqual([
      `POST ${base}`,
      `PUT ${base}/${RESERVATION}/image`,
      `PUT ${base}/${RESERVATION}/thumb`,
      `POST ${base}/${RESERVATION}/complete`,
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      purpose: 'photo',
      imageBytes: 900,
      thumbBytes: 100,
      sha256: 'a'.repeat(64),
      thumbSha256: 'b'.repeat(64),
      mimeType: 'image/webp',
      width: 2000,
      height: 1500,
    });
    expect(calls[1]!.init.headers).toEqual({ 'content-type': 'image/webp' });
    expect(JSON.parse(calls[3]!.init.body as string)).toEqual({
      caption: 'Lớp mình',
      takenYear: 2004,
    });
    // Every request carries a timeout.
    for (const call of calls) expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('an avatar puts no thumb and reserves zero thumb bytes', async () => {
    const calls = server(happy);
    await uploadEncoded(encoded(false), 'avatar', {});
    expect(calls.map((call) => call.key)).not.toContain(`PUT ${base}/${RESERVATION}/thumb`);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      purpose: 'avatar',
      thumbBytes: 0,
    });
  });
});

describe('R-MEM-10 a failure after the reservation releases it', () => {
  it.each([
    ['a refused image PUT', `PUT ${base}/${RESERVATION}/image`, failure(400), 'validation'],
    [
      'a dropped thumb PUT',
      `PUT ${base}/${RESERVATION}/thumb`,
      new TypeError('offline'),
      'network',
    ],
    ['a refused complete', `POST ${base}/${RESERVATION}/complete`, failure(409), 'conflict'],
  ] as const)('%s', async (_label, key, answer, code) => {
    const calls = server({ ...happy, [key]: answer });
    await expect(uploadEncoded(encoded(), 'photo', {})).rejects.toEqual(new UploadError(code));
    expect(calls.at(-1)?.key).toBe(`DELETE ${base}/${RESERVATION}`);
    expect(calls.at(-1)?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a failed release still reports the original failure', async () => {
    server({
      ...happy,
      [`PUT ${base}/${RESERVATION}/image`]: failure(413),
      [`DELETE ${base}/${RESERVATION}`]: new TypeError('offline'),
    });
    await expect(uploadEncoded(encoded(), 'photo', {})).rejects.toEqual(
      new UploadError('payload_too_large'),
    );
  });

  it.each([
    [507, 'storage_full'],
    [429, 'rate_limited'],
    [400, 'validation'],
    [403, 'denied'],
    [500, 'internal'],
  ] as const)(
    'a reservation refused with %i is %s and leaves nothing to release',
    async (status, code) => {
      const calls = server({ [`POST ${base}`]: failure(status) });
      await expect(uploadEncoded(encoded(), 'photo', {})).rejects.toEqual(new UploadError(code));
      expect(calls.map((call) => call.key)).toEqual([`POST ${base}`]);
    },
  );
});

describe('R-API-02 a refusal is read by its code, then its status', () => {
  const coded = (status: number, code: string) =>
    new Response(JSON.stringify({ error: { code, message: 'x', requestId: 'r' } }), { status });

  it.each([
    [423, 'locked', 'locked'],
    [404, 'not_found', 'conflict'],
    [503, 'unavailable', 'unavailable'],
    [415, 'validation', 'validation'],
    [403, 'feature_disabled', 'denied'],
    // The code wins over a status that would say otherwise.
    [400, 'storage_full', 'storage_full'],
  ] as const)('%i %s is %s', async (status, code, expected) => {
    expect(await failureOf(coded(status, code))).toBe(expected);
  });

  it('R-MEM-13 a rate_limited body names its limit; one without a reason stays plain', async () => {
    const limited = (reason?: string) =>
      new Response(
        JSON.stringify({ error: { code: 'rate_limited', message: 'x', requestId: 'r', reason } }),
        { status: 429 },
      );
    expect(await failureOf(limited('daily'))).toBe('rate_limited_daily');
    expect(await failureOf(limited('concurrent'))).toBe('rate_limited_concurrent');
    expect(await failureOf(limited())).toBe('rate_limited');
    expect(await failureOf(limited('other'))).toBe('rate_limited');
  });

  it.each([
    [415, 'validation'],
    [423, 'locked'],
    [404, 'conflict'],
    [503, 'unavailable'],
    [502, 'internal'],
  ] as const)('a %i without a readable body is %s', async (status, expected) => {
    expect(await failureOf(new Response('<html>', { status }))).toBe(expected);
    expect(await failureOf(coded(status, 'not-a-code'))).toBe(expected);
  });
});

it('R-MEM-13 setAvatar patches the profile with the new media id', async () => {
  const calls = server({ 'PATCH /api/v1/me': ok({}) });
  await setAvatar(MEDIA);
  expect(calls.map((call) => call.key)).toEqual(['PATCH /api/v1/me']);
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ avatarMediaId: MEDIA });
});
