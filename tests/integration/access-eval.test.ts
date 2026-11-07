import { applyD1Migrations, env } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { invites, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { createTestKey, signAccessJwt } from '../fixtures/access-jwt';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, type Harness } from '../fixtures/pipeline-harness';

// AC-AUTH-22 (R-AUTH-33): Access's External Evaluation rule asks the site at login, by D1 membership.

const PENDING = {
  id: '01900000-0000-7000-8000-0000000000e1',
  email: 'pending.invite@example.test',
};

let database: Database;
let harness: Harness;
let without: Harness;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  const now = Date.now();
  await database.db
    .insert(users)
    .values({
      id: PENDING.id,
      authEmail: PENDING.email,
      displayName: 'Pending Invite',
      displayNameNorm: 'pending invite',
      role: 'member',
      status: 'invited',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await database.db
    .insert(invites)
    .values({
      id: '01900000-0000-7000-8000-0000000000e2',
      email: PENDING.email,
      invitedBy: PEOPLE.admin.id,
      status: 'pending',
      createdAt: now,
      expiresAt: now + 86_400_000,
    })
    .onConflictDoNothing();
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  harness = await createHarness(database, {
    accessEvalKey: JSON.stringify(await exportJWK(privateKey)),
  });
  without = await createHarness(database);
});

/** Access's request: a team-signed token with the identity and a nonce, posted with no Origin. */
async function evaluationToken(email: string, nonce = 'nonce-123') {
  return signAccessJwt(harness.teamKey, { email: null, extra: { identity: { email }, nonce } });
}

async function evaluate(target: Harness, token: string) {
  return target.send('/access-eval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function answer(token: string) {
  const response = await evaluate(harness, token);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string };
  const keys = await (await harness.send('/access-eval/keys')).json();
  const { payload, protectedHeader } = await jwtVerify(
    body.token,
    createLocalJWKSet(keys as Parameters<typeof createLocalJWKSet>[0]),
    { algorithms: ['RS256'] },
  );
  expect(protectedHeader.kid).toBeTruthy();
  expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
  return payload;
}

describe('AC-AUTH-22 External Evaluation', () => {
  it('allows active members and pending invitees, with the nonce echoed and a key-signed answer', async () => {
    for (const email of [PEOPLE.active.email, PEOPLE.admin.email.toUpperCase(), PENDING.email]) {
      const payload = await answer(await evaluationToken(email, `n-${email}`));
      expect(payload).toMatchObject({ success: true, nonce: `n-${email}` });
    }
  });

  it('refuses suspended, revoked, expired and unknown emails', async () => {
    for (const person of [PEOPLE.suspended, PEOPLE.revoked, PEOPLE.expired, PEOPLE.unknown]) {
      const payload = await answer(await evaluationToken(person.email));
      expect(payload.success).toBe(false);
    }
  });

  it('gives no answer to a token Access did not sign, or one without a nonce', async () => {
    const stranger = await createTestKey('team-key');
    const forged = await signAccessJwt(stranger, {
      email: null,
      extra: { identity: { email: PEOPLE.active.email }, nonce: 'x' },
    });
    const noNonce = await signAccessJwt(harness.teamKey, { email: PEOPLE.active.email });
    for (const token of [forged, noNonce, 'not-a-jwt']) {
      expect((await evaluate(harness, token)).status).toBe(400);
    }
    const topLevel = await signAccessJwt(harness.teamKey, {
      email: PEOPLE.active.email,
      extra: { nonce: 'x' },
    });
    const wrongIssuer = await signAccessJwt(harness.teamKey, {
      email: null,
      iss: 'https://other-team.cloudflareaccess.com',
      extra: { identity: { email: PEOPLE.active.email }, nonce: 'x' },
    });
    const expired = await signAccessJwt(harness.teamKey, {
      email: null,
      expiresIn: -600,
      extra: { identity: { email: PEOPLE.active.email }, nonce: 'x' },
    });
    for (const token of [topLevel, wrongIssuer, expired]) {
      expect((await evaluate(harness, token)).status).toBe(400);
    }
    const garbage = await harness.send('/access-eval', { method: 'POST', body: '{' });
    expect(garbage.status).toBe(400);
    const huge = await harness.send('/access-eval', {
      method: 'POST',
      body: JSON.stringify({ token: 'x'.repeat(20_000) }),
    });
    expect(huge.status).toBe(400);
  });

  it('answers 404 without the key, and never reaches a route', async () => {
    const token = await evaluationToken(PEOPLE.active.email);
    expect((await evaluate(without, token)).status).toBe(404);
    expect((await without.send('/access-eval/keys')).status).toBe(404);
    expect((await harness.send('/access-eval')).status).toBe(405);
    expect((await harness.send('/access-eval/keys', { method: 'POST' })).status).toBe(405);
    expect(harness.resolved).toEqual([]);
  });

  it('publishes only the public half of the key', async () => {
    const { keys } = (await (await harness.send('/access-eval/keys')).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]!).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });

  it('reads only: a pending invitee stays invited after the answer', async () => {
    await answer(await evaluationToken(PENDING.email));
    const rows = await database.db.select({ status: users.status }).from(users);
    expect(rows.filter((row) => row.status === 'invited')).toHaveLength(3);
  });
});
