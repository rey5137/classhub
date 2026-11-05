import { SignJWT } from 'jose';
import { AUDIENCE, ISSUER, signAccessJwt, unsignedJwt, type TestKey } from './access-jwt';

// R-AUTH-03: every forged or unverifiable assertion the security suite sends,
// to the Access adapter and through the request pipeline.

export interface ForgedCase {
  name: string;
  headers: () => Promise<Record<string, string>>;
}

export async function forgedCases(teamKey: TestKey, otherKey: TestKey): Promise<ForgedCase[]> {
  const now = Math.floor(Date.now() / 1000);
  return [
    { name: 'no assertion', headers: async () => ({}) },
    {
      name: 'unsigned (alg: none) JWT',
      headers: async () => ({
        'cf-access-jwt-assertion': unsignedJwt({
          iss: ISSUER,
          aud: [AUDIENCE],
          sub: 'sub-member',
          email: 'member@example.test',
          exp: now + 300,
        }),
      }),
    },
    {
      name: 'JWT signed by another key',
      // Same kid as the team key, so only the signature differs.
      headers: async () => ({
        'cf-access-jwt-assertion': await signAccessJwt(otherKey, { kid: teamKey.kid }),
      }),
    },
    {
      name: 'JWT with an unknown kid',
      headers: async () => ({ 'cf-access-jwt-assertion': await signAccessJwt(otherKey) }),
    },
    {
      name: 'HS256 JWT keyed with the public key',
      headers: async () => {
        const secret = new TextEncoder().encode(JSON.stringify(teamKey.publicJwk));
        const token = await new SignJWT({ email: 'member@example.test' })
          .setProtectedHeader({ alg: 'HS256', kid: teamKey.kid })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject('sub-member')
          .setExpirationTime(now + 300)
          .sign(secret);
        return { 'cf-access-jwt-assertion': token };
      },
    },
    {
      name: 'wrong aud',
      headers: async () => ({
        'cf-access-jwt-assertion': await signAccessJwt(teamKey, { aud: 'another-application' }),
      }),
    },
    {
      name: 'wrong iss',
      headers: async () => ({
        'cf-access-jwt-assertion': await signAccessJwt(teamKey, {
          iss: 'https://other-team.cloudflareaccess.com',
        }),
      }),
    },
    {
      name: 'expired',
      headers: async () => ({
        'cf-access-jwt-assertion': await signAccessJwt(teamKey, { expiresIn: -120 }),
      }),
    },
    {
      name: 'no exp claim',
      headers: async () => {
        const token = await new SignJWT({ email: 'member@example.test' })
          .setProtectedHeader({ alg: 'RS256', kid: teamKey.kid })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject('sub-member')
          .sign(teamKey.privateKey);
        return { 'cf-access-jwt-assertion': token };
      },
    },
    {
      name: 'tampered payload',
      headers: async () => {
        const [header, , signature] = (await signAccessJwt(teamKey)).split('.');
        const payload = btoa(
          JSON.stringify({
            iss: ISSUER,
            aud: AUDIENCE,
            sub: 'sub-member',
            email: 'admin@example.test',
            exp: now + 300,
          }),
        )
          .replace(/=+$/, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        return { 'cf-access-jwt-assertion': `${header}.${payload}.${signature}` };
      },
    },
    {
      name: 'AC-AUTH-02 forged Cf-Access-Authenticated-User-Email header alone',
      headers: async () => ({ 'cf-access-authenticated-user-email': 'member@example.test' }),
    },
    {
      name: 'AC-AUTH-02 forged email header with an expired JWT',
      headers: async () => ({
        'cf-access-authenticated-user-email': 'member@example.test',
        'cf-access-jwt-assertion': await signAccessJwt(teamKey, { expiresIn: -120 }),
      }),
    },
    {
      name: 'CF_Authorization cookie on a plain page request',
      headers: async () => ({ cookie: `CF_Authorization=${await signAccessJwt(teamKey)}` }),
    },
  ];
}
