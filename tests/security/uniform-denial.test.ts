import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import type { ObjectStorage } from '../../src/lib/server/ports/object-storage';
import { seedDeletedMedia } from '../fixtures/housekeeping';
import { resolveMediaRoute } from '../fixtures/media-routes';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { comparable, createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database);
});

afterAll(() => database.close());

const causes = {
  'unknown email': PEOPLE.unknown.email,
  'revoked invite': PEOPLE.revoked.email,
  'expired invite': PEOPLE.expired.email,
  'suspended user': PEOPLE.suspended.email,
};

const kinds = {
  page: { path: '/members', options: {} },
  data: { path: '/members', options: { isDataRequest: true } },
  api: {
    path: '/api/v1/posts',
    options: {
      method: 'POST',
      routeId: null,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{"title":"hello"}',
    },
  },
} as const;

describe('uniform denial', () => {
  for (const [kind, { path, options }] of Object.entries(kinds)) {
    it(`AC-AUTH-05 the four causes get identical ${kind} responses`, async () => {
      const results = [];
      for (const email of Object.values(causes)) {
        const response = await harness.send(path, {
          ...options,
          headers: {
            ...('headers' in options ? options.headers : {}),
            ...(await harness.as(email)),
          },
        });
        expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
        results.push(await comparable(response));
      }
      for (const result of results.slice(1)) expect(result).toEqual(results[0]);
      // Nothing in the response names the cause or the email.
      const text = JSON.stringify(results[0]);
      for (const email of Object.values(causes)) expect(text).not.toContain(email);
      expect(text).not.toMatch(/suspend|revok|expir|invite/i);
      expect(harness.resolved).toEqual([]);
    });
  }

  it('AC-AUTH-05 the kinds take the R-AUTH-11 shapes', async () => {
    const headers = await harness.as(PEOPLE.suspended.email);
    const page = await harness.send('/members', { headers });
    expect([page.status, page.headers.get('location')]).toEqual([303, '/denied']);

    const api = await harness.send('/api/v1/me', { headers, routeId: null });
    expect(api.status).toBe(403);
    const body = (await api.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.requestId).toBe(api.headers.get('x-request-id'));
  });

  it('AC-AUTH-05 /denied is the same 403 page for every cause, with the nonce masked', async () => {
    const pages = [];
    for (const email of [...Object.values(causes), PEOPLE.active.email]) {
      const response = await harness.send('/denied', { headers: await harness.as(email) });
      expect(response.status).toBe(403);
      pages.push(await comparable(response));
    }
    for (const page of pages.slice(1)) expect(page).toEqual(pages[0]);
    expect(pages[0]!.body).toContain('nonce="__nonce__"');
  });

  it('AC-MEM-07 a copied media URL without Access or by a suspended member gets the uniform denial', async () => {
    const photo = await seedDeletedMedia(database, { deletedAt: null });
    const bytes = new Uint8Array([82, 73, 70, 70]);
    const storage = {
      get: vi.fn(async () => ({
        body: new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
        size: bytes.length,
        contentType: 'image/webp',
      })),
    } as unknown as ObjectStorage;
    const media = await createHarness(database, { storage, resolve: resolveMediaRoute });
    const path = `/api/v1/media/${photo.id}/image`;
    // The URL is real: the owner's own session streams it.
    const owner = await media.send(path, { headers: await media.as(PEOPLE.active.email) });
    expect(owner.status).toBe(200);
    expect(storage.get).toHaveBeenCalledTimes(1);

    const copies = [
      await media.send(path),
      await media.send(path, { headers: await media.as(PEOPLE.suspended.email) }),
      await media.send(path, { headers: await media.as(PEOPLE.unknown.email) }),
    ];
    const answers = [];
    for (const response of copies) {
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toContain('application/json');
      answers.push(await comparable(response));
    }
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
    expect(JSON.stringify(answers[0])).not.toMatch(/suspend|webp|media\/v1/i);
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(media.resolved).toEqual([`GET ${path}`]);
  });
});
