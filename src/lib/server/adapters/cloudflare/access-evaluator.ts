import { calculateJwkThumbprint, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import type { AccessEvaluator } from '../../ports/access-evaluator';
import { JwksCache, sharedJwks, teamOrigin } from './access-identity';

const ALG = 'RS256';
const ANSWER_TTL_S = 60;
const CLOCK_TOLERANCE_S = 60;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AccessEvaluatorOptions {
  teamDomain: string;
  /** The `ACCESS_EVAL_KEY` secret: an RSA private key as a JWK, JSON-encoded. */
  privateKey: string;
  fetch?: Fetch;
  now?: () => number;
}

/** Only `identity.email`, the evaluation token's shape: a token with a top-level email is another kind. */
function emailOf(payload: Record<string, unknown>): string {
  const identity = payload.identity;
  const email =
    identity && typeof identity === 'object'
      ? (identity as Record<string, unknown>).email
      : undefined;
  return typeof email === 'string' ? email.trim() : '';
}

const evaluators = new Map<string, AccessEvaluator | undefined>();

/** One evaluator per isolate, team and key: the context is built per request. */
export function sharedAccessEvaluator(
  teamDomain: string,
  privateKey: string,
): AccessEvaluator | undefined {
  const cacheKey = `${teamDomain}\n${privateKey}`;
  if (!evaluators.has(cacheKey)) {
    evaluators.clear();
    evaluators.set(cacheKey, createAccessEvaluator({ teamDomain, privateKey }));
  }
  return evaluators.get(cacheKey);
}

/**
 * R-AUTH-33: verifies Access's evaluation token against the team's keys (the same ones as the
 * per-request assertion, R-AUTH-04) and answers with a token signed by this site's key. Returns
 * undefined when the secret is not a usable RSA private JWK, so the evaluation paths stay off.
 */
export function createAccessEvaluator(
  options: AccessEvaluatorOptions,
): AccessEvaluator | undefined {
  let issuer: string;
  let parsed: unknown;
  try {
    issuer = teamOrigin(options.teamDomain);
    parsed = JSON.parse(options.privateKey);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const privateJwk = parsed as JWK;
  const text = (value: unknown) => typeof value === 'string' && value.length > 0;
  if (
    privateJwk.kty !== 'RSA' ||
    !text(privateJwk.n) ||
    !text(privateJwk.e) ||
    !text(privateJwk.d)
  ) {
    return undefined;
  }
  const publicJwk: JWK = { kty: 'RSA', n: privateJwk.n, e: privateJwk.e };
  const jwks = options.fetch
    ? new JwksCache(`${issuer}/cdn-cgi/access/certs`, options.fetch, options.now)
    : sharedJwks(issuer);
  const now = options.now ?? Date.now;
  // Both on first use, so a key that fails to import fails that evaluation and nothing else.
  let kid: Promise<string> | undefined;
  const keyId = () => (kid ??= calculateJwkThumbprint(publicJwk));
  let signingKey: ReturnType<typeof importJWK> | undefined;

  return {
    async keys() {
      return { keys: [{ ...publicJwk, kid: await keyId(), alg: ALG, use: 'sig' }] };
    },
    async evaluate(token, allow) {
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, jwks.getKey, {
          algorithms: [ALG],
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ['exp', 'nonce'],
          currentDate: new Date(now()),
        }));
      } catch {
        return null;
      }
      // Access's own token: when it names an issuer, it is this team.
      if (payload.iss !== undefined && payload.iss !== issuer) return null;
      const nonce = payload.nonce;
      const email = emailOf(payload);
      if (typeof nonce !== 'string' || !nonce || !email) return null;

      const success = await allow(email);
      signingKey ??= importJWK({ ...privateJwk, alg: ALG }, ALG);
      const iat = Math.floor(now() / 1000);
      return new SignJWT({ success, nonce })
        .setProtectedHeader({ alg: ALG, kid: await keyId() })
        .setIssuedAt(iat)
        .setExpirationTime(iat + ANSWER_TTL_S)
        .sign(await signingKey);
    },
  };
}
