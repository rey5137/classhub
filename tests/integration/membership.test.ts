import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { auditEvents, invites, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import { inviteMember, revokeInvite, suspendMember } from '../../src/lib/server/services/members';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import {
  comparable,
  createHarness,
  recordingHub,
  type Harness,
} from '../fixtures/pipeline-harness';

let database: Database;
let harness: Harness;
const admin = { id: PEOPLE.admin.id, role: 'admin' as const, displayName: 'Class Admin' };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  harness = await createHarness(database);
});

const services = () => ({ database, realtime: recordingHub() });

async function userByEmail(email: string) {
  const rows = await database.db.select().from(users).where(eq(users.authEmail, email));
  return rows[0];
}

async function inviteByEmail(email: string) {
  const rows = await database.db.select().from(invites).where(eq(invites.email, email));
  return rows[0];
}

describe('invite → active (R-AUTH-08)', () => {
  it('AC-AUTH-04 activates an invited email on its first verified login and records the sub', async () => {
    const email = 'first.login@example.test';
    await inviteMember(services(), admin, { email, displayName: 'First Login', role: 'member' });
    expect((await userByEmail(email))?.status).toBe('invited');

    const response = await harness.send('/', { headers: await harness.as(email, 'sub-first') });
    expect(response.status).toBe(200);
    expect(await userByEmail(email)).toMatchObject({ status: 'active', accessSub: 'sub-first' });
    expect((await inviteByEmail(email))?.status).toBe('accepted');
  });

  it('AC-AUTH-04 denies an uninvited email and creates no row', async () => {
    const email = 'never.invited@example.test';
    const response = await harness.send('/', { headers: await harness.as(email) });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/denied');
    expect(await userByEmail(email)).toBeUndefined();
    expect(await inviteByEmail(email)).toBeUndefined();
  });

  it('AC-AUTH-13 a revoked or expired invite never activates: zero rows change', async () => {
    const revoked = 'revoked.later@example.test';
    const outcome = await inviteMember(services(), admin, {
      email: revoked,
      displayName: 'Revoked Later',
      role: 'member',
    });
    if (!outcome.ok) throw new Error('invite refused');
    await revokeInvite(services(), admin, outcome.inviteId);

    for (const email of [revoked, PEOPLE.revoked.email, PEOPLE.expired.email]) {
      const before = await userByEmail(email);
      const response = await harness.send('/api/v1/me', { headers: await harness.as(email) });
      expect(response.status, email).toBe(403);
      expect(await userByEmail(email), email).toEqual(before);
      expect((await inviteByEmail(email))?.status, email).not.toBe('accepted');
    }
  });
});

describe('subject check (R-AUTH-25)', () => {
  it('AC-AUTH-14 matches a changed sub by email, audits it without the email, and re-links after a restore', async () => {
    const email = PEOPLE.active.email;
    const first = await harness.send('/', { headers: await harness.as(email, 'sub-original') });
    expect(first.status).toBe(200);
    expect((await userByEmail(email))?.accessSub).toBe('sub-original');
    const audited = () =>
      database.db.select().from(auditEvents).where(eq(auditEvents.action, 'access_sub_changed'));
    expect(await audited()).toHaveLength(0);

    const changed = await harness.send('/', { headers: await harness.as(email, 'sub-new') });
    expect(changed.status).toBe(200);
    expect((await userByEmail(email))?.accessSub).toBe('sub-new');
    const events = await audited();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityType: 'user', entityId: PEOPLE.active.id });
    expect(JSON.stringify(events[0])).not.toContain(email);

    // R-BAK-14: a restore clears access_sub; the next login re-links by email, silently.
    await database.db.update(users).set({ accessSub: null }).where(eq(users.authEmail, email));
    const relinked = await harness.send('/', { headers: await harness.as(email, 'sub-restored') });
    expect(relinked.status).toBe(200);
    expect((await userByEmail(email))?.accessSub).toBe('sub-restored');
    expect(await audited()).toHaveLength(1);
  });
});

describe('member states (R-NAV-04)', () => {
  it('AC-NAV-03 an invited-then-revoked or suspended user gets the uniform denial on every page and API', async () => {
    const suspendedNow = 'suspended.now@example.test';
    const outcome = await inviteMember(services(), admin, {
      email: suspendedNow,
      displayName: 'Suspended Now',
      role: 'member',
    });
    if (!outcome.ok) throw new Error('invite refused');
    await harness.send('/', { headers: await harness.as(suspendedNow) });
    const row = await userByEmail(suspendedNow);
    expect(row?.status).toBe('active');
    await suspendMember(services(), admin, row!.id);

    const routes: [string, { method?: string; isDataRequest?: boolean }][] = [
      ['/', {}],
      ['/members', {}],
      ['/admin', {}],
      ['/members/__data.json', { isDataRequest: true }],
      ['/api/v1/me', {}],
      ['/api/v1/admin/invites', {}],
    ];
    for (const [path, options] of routes) {
      const baseline = await comparable(
        await harness.send(path, { ...options, headers: await harness.as(PEOPLE.unknown.email) }),
      );
      for (const email of [suspendedNow, PEOPLE.suspended.email, PEOPLE.revoked.email]) {
        const response = await harness.send(path, { ...options, headers: await harness.as(email) });
        expect(await comparable(response), `${email} ${path}`).toEqual(baseline);
      }
    }
  });
});
