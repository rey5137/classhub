import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { seedMembership, setSetupState } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// AC-AUTH-21 (R-AUTH-32): /privacy answers without any identity, locked or not, before membership.

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;
const members: unknown[] = [];

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database, {
    resolve: (event: RequestEvent) => {
      members.push(event.locals.member);
      return new Response('privacy', { headers: { 'content-type': 'text/html' } });
    },
  });
});

afterAll(() => database.close());

describe('AC-AUTH-21 the privacy page outside Access', () => {
  it('answers 200 with no identity and resolves no member', async () => {
    const response = await harness.send('/privacy');
    expect(response.status).toBe(200);
    expect(members.at(-1) ?? null).toBeNull();
  });

  it('answers 200 while the site is locked too, and a POST still needs Access', async () => {
    await setSetupState(database, 'locked');
    expect((await harness.send('/privacy')).status).toBe(200);
    await setSetupState(database, 'unlocked');
    const post = await harness.send('/privacy', { method: 'POST', headers: { origin: ORIGIN } });
    expect(post.status).not.toBe(200);
  });
});
