import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { JSON_BODY_LIMIT } from '../../src/lib/server/pipeline';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;
let received: string[] = [];

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database, {
    resolve: async (event) => {
      received.push(await event.request.text());
      return new Response('ok');
    },
  });
});

afterAll(() => database.close());

async function post(body: BodyInit, headers: Record<string, string> = {}) {
  return harness.send('/api/v1/posts', {
    method: 'POST',
    routeId: null,
    body,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(await harness.as(PEOPLE.active.email)),
      ...headers,
    },
  });
}

function chunked(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const size = Math.min(4096, bytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

async function code(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe('body limits', () => {
  it('R-AUTH-22 refuses a declared body over 64 KB before the handler runs', async () => {
    received = [];
    const response = await post(' '.repeat(JSON_BODY_LIMIT + 1));
    expect(response.status).toBe(413);
    expect(await code(response)).toBe('payload_too_large');
    expect(received).toEqual([]);
  });

  it('R-AUTH-22 refuses an undeclared (streamed) body once it passes 64 KB', async () => {
    received = [];
    const response = await post(chunked(JSON_BODY_LIMIT + 10));
    expect(response.status).toBe(413);
    expect(received).toEqual([]);
  });

  it('R-AUTH-22 hands a streamed body within the limit to the handler intact', async () => {
    received = [];
    const response = await post(chunked(1000));
    expect(response.status).toBe(200);
    expect(received).toEqual([' '.repeat(1000)]);
  });

  it('R-AUTH-22 refuses an explicit Content-Length over 64 KB, whatever the body', async () => {
    received = [];
    const response = await post('{}', { 'content-length': String(JSON_BODY_LIMIT + 1) });
    expect(response.status).toBe(413);
    expect(await code(response)).toBe('payload_too_large');
    expect(received).toEqual([]);
  });

  it('R-AUTH-22 caps the bytes read even when Content-Length understates them', async () => {
    received = [];
    for (const declared of ['10', '0']) {
      const response = await post(chunked(JSON_BODY_LIMIT + 10), { 'content-length': declared });
      expect(response.status, declared).toBe(413);
    }
    const typed = await post('x=1', { 'content-length': '0', 'content-type': 'text/plain' });
    expect(typed.status).toBe(415);
    expect(received).toEqual([]);
  });

  it('R-AUTH-22 R-AUTH-17 the JSON finalize endpoint beside the upload route is bounded and JSON-only', async () => {
    received = [];
    const member = await harness.as(PEOPLE.active.email);
    const send = (body: BodyInit, type: string) =>
      harness.send('/api/v1/media/reservations/r1/complete', {
        method: 'POST',
        routeId: null,
        body,
        headers: { origin: ORIGIN, 'content-type': type, ...member },
      });
    expect((await send(chunked(JSON_BODY_LIMIT + 10), 'application/json')).status).toBe(413);
    expect((await send('{}', 'text/plain')).status).toBe(415);
    expect(received).toEqual([]);
  });

  it('R-AUTH-17 a JSON API refuses another Content-Type with 415', async () => {
    received = [];
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
      const response = await post('{}', { 'content-type': type });
      expect(response.status, type).toBe(415);
      expect(await code(response)).toBe('validation');
    }
    expect(received).toEqual([]);
    expect((await post('{}', { 'content-type': 'application/json; charset=utf-8' })).status).toBe(
      200,
    );
  });

  it('a body-less DELETE needs no Content-Type', async () => {
    const response = await harness.send('/api/v1/posts/p1', {
      method: 'DELETE',
      routeId: null,
      headers: { origin: ORIGIN, ...(await harness.as(PEOPLE.active.email)) },
    });
    expect(response.status).toBe(200);
  });
});
