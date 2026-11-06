import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { auditEvents, rateEvents } from '../../src/lib/server/db/schema';
import {
  GOOD_TOKEN,
  joinForm,
  renderJoin,
  setJoin,
  storedRequests,
  stubTurnstile,
} from '../fixtures/join-route';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import {
  comparable,
  createHarness,
  recordingHub,
  type Harness,
} from '../fixtures/pipeline-harness';
import type { Member } from '../../src/lib/server/auth/membership';
import { inviteMember } from '../../src/lib/server/services/members';

// AC-AUTH-16 (R-AUTH-28): the reply to `POST /join` says nothing about the email.

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;

const INVITED = 'invited.classmate@example.test';

beforeAll(async () => {
  await seedMembership(database);
  const invited = await inviteMember(
    { database, realtime: recordingHub() },
    { id: PEOPLE.admin.id, role: 'admin' } as Member,
    { email: INVITED, displayName: 'Invited Classmate', role: 'member' },
  );
  expect(invited).toMatchObject({ ok: true, created: true });
  // The invite's own audit row is the setup's, not the submissions'.
  await database.db.delete(auditEvents);
  await setJoin(database, true);
  harness = await createHarness(database, { resolve: renderJoin, turnstile: stubTurnstile });
});

afterAll(() => database.close());

let address = 0;
const submit = (email: string, headers: Record<string, string> = {}) => {
  const form = joinForm({
    name: 'Synthetic Classmate',
    email,
    note: 'Class of 2012',
    'cf-turnstile-response': GOOD_TOKEN,
  });
  // A fresh address each time, so the per-IP limit (R-AUTH-29) is not what is compared.
  address += 1;
  return harness.send('/join', {
    ...form,
    headers: { ...form.headers, ...headers },
    clientAddress: `198.51.100.${address}`,
  });
};

describe('join requests: uniform reply', () => {
  it('AC-AUTH-16 a new, already requested, member, suspended and revoked email get identical responses', async () => {
    const cases = {
      new: 'new.classmate@example.test',
      'already requested': 'new.classmate@example.test',
      member: PEOPLE.active.email,
      // Case and spaces are normalised (R-AUTH-06) before any check.
      'member, other spelling': `  ${PEOPLE.active.email.toUpperCase()} `,
      suspended: PEOPLE.suspended.email,
      revoked: PEOPLE.revoked.email,
      'live pending invite': INVITED,
      'expired invite': PEOPLE.expired.email,
    };
    const results = [];
    for (const email of Object.values(cases)) {
      const response = await submit(email);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
      results.push(await comparable(response));
    }
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
    expect(results[0]!.body).toContain('"sent":true');
    // Nothing in the reply names any of the emails.
    const text = JSON.stringify(results[0]);
    for (const email of Object.values(cases)) expect(text).not.toContain(email.trim());

    // Only the new email made a row; nothing else was written but rate events.
    expect((await storedRequests(database)).map((row) => row.email)).toEqual([
      'new.classmate@example.test',
    ]);
    expect(await database.db.select().from(auditEvents)).toEqual([]);
    const buckets = await database.db.select().from(rateEvents);
    expect(buckets.length).toBe(Object.keys(cases).length * 2);
  });

  it('AC-AUTH-16 a verified member JWT on the request changes nothing in the reply', async () => {
    const plain = await comparable(await submit('another.classmate@example.test'));
    const signed = await comparable(
      await submit('another.classmate@example.test', await harness.as(PEOPLE.active.email)),
    );
    expect(signed).toEqual(plain);
  });
});
