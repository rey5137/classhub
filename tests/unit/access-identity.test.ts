import { beforeAll, describe, expect, it } from 'vitest';
import {
  AccessIdentityProvider,
  teamOrigin,
} from '../../src/lib/server/adapters/cloudflare/access-identity';
import { IdentityError } from '../../src/lib/server/ports/identity';
import {
  AUDIENCE,
  CERTS_URL,
  createTestKey,
  fakeJwksFetch,
  jwks,
  signAccessJwt,
  TEAM_DOMAIN,
  type TestKey,
} from '../fixtures/access-jwt';

let first: TestKey;
let rotated: TestKey;

beforeAll(async () => {
  first = await createTestKey('key-1');
  rotated = await createTestKey('key-2');
});

function provider(fake: ReturnType<typeof fakeJwksFetch>, clock: { now: number }) {
  return new AccessIdentityProvider({
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    fetch: fake.fetch,
    now: () => clock.now,
  });
}

function withAssertion(token: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('cf-access-jwt-assertion', token);
  return new Request('https://classhub.example.test/', { ...init, headers });
}

describe('AccessIdentityProvider JWKS cache', () => {
  it('AC-AUTH-03 an unknown kid triggers exactly one JWKS refetch', async () => {
    const fake = fakeJwksFetch(jwks(first));
    const clock = { now: Date.now() };
    const access = provider(fake, clock);

    await access.requireIdentity(withAssertion(await signAccessJwt(first)));
    expect(fake.calls).toEqual([CERTS_URL]);

    // The team rotated its key: the first request with the new kid refetches once.
    fake.serve(jwks(first, rotated));
    const identity = await access.requireIdentity(withAssertion(await signAccessJwt(rotated)));
    expect(identity.subject).toBe('sub-member');
    expect(fake.calls).toHaveLength(2);

    // Known kids are served from the cache.
    await access.requireIdentity(withAssertion(await signAccessJwt(first)));
    expect(fake.calls).toHaveLength(2);
  });

  it('AC-AUTH-03 refetches for an unknown kid at most once a minute', async () => {
    const fake = fakeJwksFetch(jwks(first));
    const clock = { now: Date.now() };
    const access = provider(fake, clock);
    await access.requireIdentity(withAssertion(await signAccessJwt(first)));

    const stranger = await signAccessJwt(rotated);
    await expect(access.requireIdentity(withAssertion(stranger))).rejects.toThrow(IdentityError);
    await expect(access.requireIdentity(withAssertion(stranger))).rejects.toThrow(IdentityError);
    expect(fake.calls).toHaveLength(2);

    clock.now += 61_000;
    await expect(access.requireIdentity(withAssertion(stranger))).rejects.toThrow(IdentityError);
    expect(fake.calls).toHaveLength(3);
  });

  it('AC-AUTH-03 a failed JWKS fetch with no cached key denies', async () => {
    const fake = fakeJwksFetch(new Error('network down'));
    const access = provider(fake, { now: Date.now() });

    await expect(
      access.requireIdentity(withAssertion(await signAccessJwt(first))),
    ).rejects.toBeInstanceOf(IdentityError);
    expect(fake.calls).toHaveLength(1);
  });

  it('R-AUTH-04 after a failed load with no keys, denies without refetching for a minute', async () => {
    const fake = fakeJwksFetch(new Error('network down'));
    const clock = { now: Date.now() };
    const access = provider(fake, clock);
    const token = await signAccessJwt(first);

    for (let i = 0; i < 3; i += 1) {
      await expect(access.requireIdentity(withAssertion(token))).rejects.toBeInstanceOf(
        IdentityError,
      );
    }
    expect(fake.calls).toHaveLength(1);

    fake.serve(jwks(first));
    clock.now += 61_000;
    await expect(access.requireIdentity(withAssertion(token))).resolves.toBeDefined();
    expect(fake.calls).toHaveLength(2);
  });

  it('AC-AUTH-03 a non-OK JWKS response with no cached key denies', async () => {
    const access = new AccessIdentityProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: async () => new Response('oops', { status: 502 }),
    });
    await expect(
      access.requireIdentity(withAssertion(await signAccessJwt(first))),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('R-AUTH-04 keeps keys for at most 10 minutes, then denies if the refetch fails', async () => {
    const fake = fakeJwksFetch(jwks(first));
    const clock = { now: Date.now() };
    const access = provider(fake, clock);
    await access.requireIdentity(withAssertion(await signAccessJwt(first)));

    fake.serve(new Error('network down'));
    clock.now += 9 * 60_000;
    // Signed at the real time, so the token is still inside its validity window.
    await expect(
      access.requireIdentity(withAssertion(await signAccessJwt(first, { expiresIn: 3600 }))),
    ).resolves.toMatchObject({ email: 'member@example.test' });
    expect(fake.calls).toHaveLength(1);

    clock.now += 2 * 60_000;
    await expect(
      access.requireIdentity(withAssertion(await signAccessJwt(first, { expiresIn: 3600 }))),
    ).rejects.toBeInstanceOf(IdentityError);
    expect(fake.calls).toHaveLength(2);
  });

  it('passes a timeout signal to the JWKS fetch', async () => {
    let signal: AbortSignal | null | undefined;
    const access = new AccessIdentityProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(JSON.stringify(jwks(first)));
      },
    });
    await access.requireIdentity(withAssertion(await signAccessJwt(first)));
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('AccessIdentityProvider claims', () => {
  it('R-AUTH-05 denies everyone when the team domain or AUD is missing', async () => {
    const fake = fakeJwksFetch(jwks(first));
    const token = await signAccessJwt(first);
    for (const options of [
      { teamDomain: undefined, audience: AUDIENCE },
      { teamDomain: TEAM_DOMAIN, audience: undefined },
      { teamDomain: ' ', audience: AUDIENCE },
      { teamDomain: 'not a host/', audience: AUDIENCE },
    ]) {
      const access = new AccessIdentityProvider({ ...options, fetch: fake.fetch });
      await expect(access.requireIdentity(withAssertion(token))).rejects.toThrow(
        'Access is not configured',
      );
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('R-AUTH-03 accepts exp within the 60 s leeway and rejects beyond it', async () => {
    const access = provider(fakeJwksFetch(jwks(first)), { now: Date.now() });
    await expect(
      access.requireIdentity(withAssertion(await signAccessJwt(first, { expiresIn: -30 }))),
    ).resolves.toBeDefined();
    await expect(
      access.requireIdentity(withAssertion(await signAccessJwt(first, { expiresIn: -120 }))),
    ).rejects.toBeInstanceOf(IdentityError);
    await expect(
      access.requireIdentity(withAssertion(await signAccessJwt(first, { notBefore: 120 }))),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('R-AUTH-03 requires a non-empty email claim', async () => {
    const access = provider(fakeJwksFetch(jwks(first)), { now: Date.now() });
    for (const email of [null, '', '   ']) {
      await expect(
        access.requireIdentity(withAssertion(await signAccessJwt(first, { email }))),
      ).rejects.toBeInstanceOf(IdentityError);
    }
  });

  it('R-AUTH-03 reads the CF_Authorization cookie only on a WebSocket upgrade', async () => {
    const access = provider(fakeJwksFetch(jwks(first)), { now: Date.now() });
    const token = await signAccessJwt(first);
    const cookie = `theme=x; CF_Authorization=${token}`;

    await expect(
      access.requireIdentity(
        new Request('https://classhub.example.test/', { headers: { cookie } }),
      ),
    ).rejects.toThrow('no Access assertion');
    await expect(
      access.requireIdentity(
        new Request('https://classhub.example.test/api/v1/chat/ws', {
          headers: { cookie, upgrade: 'websocket' },
        }),
      ),
    ).resolves.toMatchObject({ email: 'member@example.test' });
  });

  it('never puts a claim value in the error message', async () => {
    const access = provider(fakeJwksFetch(jwks(first)), { now: Date.now() });
    const token = await signAccessJwt(first, { email: 'secret.person@example.test', aud: 'wrong' });
    const error = await access.requireIdentity(withAssertion(token)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityError);
    expect(String((error as Error).message)).not.toContain('secret.person');
    expect(String((error as Error).message)).not.toContain('wrong');
  });

  it('normalises the team domain to an https origin', () => {
    expect(teamOrigin('my-team')).toBe('https://my-team.cloudflareaccess.com');
    expect(teamOrigin('https://My-Team.cloudflareaccess.com/')).toBe(
      'https://my-team.cloudflareaccess.com',
    );
  });
});
