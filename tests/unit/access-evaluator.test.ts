import { describe, expect, it } from 'vitest';
import { createAccessEvaluator } from '../../src/lib/server/adapters/cloudflare/access-evaluator';
import { createCloudflareContext } from '../../src/lib/server/adapters/cloudflare/context';

// AC-AUTH-22 (R-AUTH-33): a malformed ACCESS_EVAL_KEY turns the evaluation off and nothing else.

const TEAM = 'classhub-test.cloudflareaccess.com';

describe('createAccessEvaluator', () => {
  it.each([
    ['null', 'null'],
    ['a PEM string', '"-----BEGIN PRIVATE KEY-----"'],
    ['not JSON', '-----BEGIN PRIVATE KEY-----'],
    ['a non-string modulus', JSON.stringify({ kty: 'RSA', n: 1, e: 'AQAB', d: 'x' })],
    ['a public key', JSON.stringify({ kty: 'RSA', n: 'abc', e: 'AQAB' })],
    ['an EC key', JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' })],
  ])('is off for %s', (_label, privateKey) => {
    expect(createAccessEvaluator({ teamDomain: TEAM, privateKey })).toBeUndefined();
  });

  it('leaves the context working with a malformed key', () => {
    const context = createCloudflareContext({
      DB: {},
      MEDIA: {},
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: 'aud',
      ACCESS_EVAL_KEY: 'null',
    });
    expect(context.accessEvaluator).toBeUndefined();
    expect(context.accessConfigured).toBe(true);
  });
});
