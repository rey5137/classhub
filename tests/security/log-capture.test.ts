import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { handleServerError } from '../../src/lib/server/pipeline';
import { createTestKey } from '../fixtures/access-jwt';
import { forgedCases } from '../fixtures/forged-identity';
import { FIXTURE_PHONE, PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN } from '../fixtures/pipeline-harness';
import { captured, FIXTURE_BODY, forbiddenInLogs } from './setup-log-capture';

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });

beforeAll(() => seedMembership(database));
afterAll(() => database.close());

describe('log capture', () => {
  it('AC-AUTH-12 no log line carries a fixture email, phone, message body or JWT', async () => {
    const start = captured.length;
    const harness = await createHarness(database, {
      resolve: (event) => {
        if (event.url.pathname === '/boom') {
          throw new Error(`failed for ${PEOPLE.active.email} at ${FIXTURE_PHONE}`);
        }
        return new Response('ok');
      },
    });

    for (const forged of await forgedCases(harness.teamKey, await createTestKey('other'))) {
      await harness.send('/members', { headers: await forged.headers() });
    }
    for (const person of Object.values(PEOPLE)) {
      await harness.send('/members', { headers: await harness.as(person.email) });
    }
    await harness.send('/api/v1/posts', {
      method: 'POST',
      routeId: null,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        ...(await harness.as(PEOPLE.active.email)),
      },
      body: JSON.stringify({ body: FIXTURE_BODY, phone: FIXTURE_PHONE }),
    });
    await harness.send('/boom', { headers: await harness.as(PEOPLE.active.email) });
    handleServerError({
      error: new Error(`user ${PEOPLE.admin.email} token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig`),
      event: { locals: { requestId: 'req-1' }, route: { id: '/members' } } as never,
      status: 500,
      message: 'Internal Error',
    });

    const lines = captured.slice(start);
    // The run logged: one line per request, with the denial reasons and hashes.
    expect(lines.length).toBeGreaterThanOrEqual(22);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.some((line) => line.denied === 'no_identity')).toBe(true);
    expect(
      parsed.some((line) => line.denied === 'no_membership' && typeof line.subject === 'string'),
    ).toBe(true);
    expect(parsed.some((line) => typeof line.member === 'string' && line.status === 200)).toBe(
      true,
    );
    expect(
      parsed.some((line) => line.status === 503 && String(line.error).includes('[email]')),
    ).toBe(true);
    for (const line of lines) expect(forbiddenInLogs(line), line).toBeNull();
    expect(lines.join('\n')).not.toContain(PEOPLE.active.id);
  });

  it('R-AUTH-23 a 4xx error logs the route pattern and status, never the raw path', () => {
    const start = captured.length;
    handleServerError({
      error: new Error('Not found: /members/some-private-slug/x'),
      event: { locals: { requestId: 'req-404' }, route: { id: null } } as never,
      status: 404,
      message: 'Not Found',
    });
    const line = captured[start]!;
    expect(line).not.toContain('some-private-slug');
    expect(JSON.parse(line)).toEqual({ requestId: 'req-404', route: 'unmatched', status: 404 });
  });

  it('the detector itself flags each kind of leak', () => {
    expect(forbiddenInLogs('{"x":"someone@example.com"}')).toBe('an email');
    expect(forbiddenInLogs(`call ${FIXTURE_PHONE}`)).toBe('a phone');
    expect(forbiddenInLogs(FIXTURE_BODY)).toBe('a message body');
    expect(forbiddenInLogs('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc')).toBe('a JWT');
    expect(forbiddenInLogs('{"requestId":"0190","status":403}')).toBeNull();
  });
});
