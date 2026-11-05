import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccessIdentityProvider } from '../../src/lib/server/adapters/cloudflare/access-identity';
import { IdentityError } from '../../src/lib/server/ports/identity';
import {
  AUDIENCE,
  createTestKey,
  fakeJwksFetch,
  jwks,
  signAccessJwt,
  TEAM_DOMAIN,
  type TestKey,
} from '../fixtures/access-jwt';
import { forgedCases } from '../fixtures/forged-identity';

// R-AUTH-03 against a local JWKS: every forged or unverifiable assertion is
// refused by the Access adapter.

let team: TestKey;
let stranger: TestKey;

beforeAll(async () => {
  team = await createTestKey('team-key');
  stranger = await createTestKey('stranger-key');
});

function access(): AccessIdentityProvider {
  return new AccessIdentityProvider({
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    fetch: fakeJwksFetch(jwks(team)).fetch,
  });
}

describe('forged identity at the Access adapter', () => {
  it('AC-AUTH-01 AC-AUTH-02 refuses every forged or unverifiable assertion', async () => {
    const provider = access();
    const cases = await forgedCases(team, stranger);
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const forged of cases) {
      const request = new Request('https://classhub.example.test/members', {
        headers: await forged.headers(),
      });
      await expect(provider.requireIdentity(request), forged.name).rejects.toBeInstanceOf(
        IdentityError,
      );
    }
  });

  it('accepts a genuine team-signed assertion (the cases above are not refused for setup reasons)', async () => {
    const request = new Request('https://classhub.example.test/members', {
      headers: { 'cf-access-jwt-assertion': await signAccessJwt(team) },
    });
    await expect(access().requireIdentity(request)).resolves.toEqual({
      email: 'member@example.test',
      subject: 'sub-member',
    });
  });

  it('AC-AUTH-01 refuses an RS256 key of the right shape published under another team', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const otherTeam = { kid: 'team-key', privateKey, publicJwk: await exportJWK(publicKey) };
    const token = await signAccessJwt(otherTeam, { iss: 'https://other.cloudflareaccess.com' });
    const request = new Request('https://classhub.example.test/', {
      headers: { 'cf-access-jwt-assertion': token },
    });
    await expect(access().requireIdentity(request)).rejects.toBeInstanceOf(IdentityError);
  });
});
