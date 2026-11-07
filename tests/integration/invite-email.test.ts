import { applyD1Migrations, env } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { createRecordingMailer } from '../../src/lib/server/adapters/recording/mailer';
import { auditEvents, invites } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import * as invitesApi from '../../src/routes/api/v1/admin/invites/+server';
import * as emailApi from '../../src/routes/api/v1/admin/invites/[id]/email/+server';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// AC-AUTH-20 (R-AUTH-31): the invite email, through the pipeline and the real handlers on D1.

type Handler = (event: RequestEvent) => Response | Promise<Response>;

function route(event: RequestEvent): Response | Promise<Response> {
  const method = event.request.method;
  if (event.url.pathname === '/api/v1/admin/invites') {
    return (invitesApi as unknown as Record<string, Handler>)[method]!(event);
  }
  if (/^\/api\/v1\/admin\/invites\/[^/]+\/email$/.test(event.url.pathname)) {
    return (emailApi as unknown as Record<string, Handler>)[method]!(event);
  }
  return new Response('no route', { status: 404 });
}

let database: Database;
const recording = createRecordingMailer();
let withMail: Harness;
let withoutMail: Harness;
let failing: Harness;

const INVITEE = 'new.friend@example.test';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  withMail = await createHarness(database, { resolve: route, mailer: recording.mailer });
  withoutMail = await createHarness(database, { resolve: route });
  failing = await createHarness(database, {
    resolve: route,
    mailer: createRecordingMailer({ fail: true }).mailer,
  });
  const created = await withMail.send('/api/v1/admin/invites', {
    method: 'POST',
    headers: {
      ...(await withMail.as(PEOPLE.admin.email)),
      origin: ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email: INVITEE, displayName: 'Lan Anh', role: 'member' }),
  });
  expect(created.status).toBe(201);
});

async function inviteId(email: string) {
  const [row] = await database.db
    .select({ id: invites.id })
    .from(invites)
    .where(eq(invites.email, email));
  return row!.id;
}

async function emailInvite(harness: Harness, as: string, id: string) {
  return harness.send(`/api/v1/admin/invites/${id}/email`, {
    method: 'POST',
    headers: { ...(await harness.as(as)), origin: ORIGIN },
    params: { id },
  });
}

async function code(response: Response) {
  return errorBodySchema.parse(await response.json()).error.code;
}

describe('AC-AUTH-20 invite email', () => {
  it('sends one Vietnamese email to a pending invitee and audits it with ids only', async () => {
    const id = await inviteId(INVITEE);
    const response = await emailInvite(withMail, PEOPLE.admin.email, id);
    expect(response.status).toBe(200);
    expect(recording.sent).toHaveLength(1);
    const [mail] = recording.sent;
    expect(mail!.to).toBe(INVITEE);
    expect(mail!.subject).toMatch(/^Lời mời tham gia /);
    expect(mail!.text).toContain('Chào Lan Anh,');
    expect(mail!.text).toContain(ORIGIN);
    expect(mail!.text).toContain('Lời mời có hiệu lực đến ngày');
    const audits = await database.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'invite.emailed'), eq(auditEvents.entityId, id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(INVITEE);
  });

  it('sends nothing for a member, an accepted or revoked invite, or without a mailer', async () => {
    const before = recording.sent.length;
    const id = await inviteId(INVITEE);
    expect(await code(await emailInvite(withMail, PEOPLE.active.email, id))).toBe('forbidden');
    expect(await code(await emailInvite(withoutMail, PEOPLE.admin.email, id))).toBe('unavailable');
    expect(await code(await emailInvite(failing, PEOPLE.admin.email, id))).toBe('unavailable');
    expect(
      await code(
        await emailInvite(withMail, PEOPLE.admin.email, '01900000-0000-7000-8000-0000000000ff'),
      ),
    ).toBe('not_found');
    await database.db.update(invites).set({ status: 'revoked' }).where(eq(invites.id, id));
    expect(await code(await emailInvite(withMail, PEOPLE.admin.email, id))).toBe('conflict');
    expect(recording.sent).toHaveLength(before);
  });
});
