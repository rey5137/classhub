import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { IdentityError, type IdentityProvider, type VerifiedIdentity } from '../../ports/identity';

const JWKS_MAX_AGE_MS = 10 * 60_000;
const REFETCH_COOLDOWN_MS = 60_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_TOLERANCE_S = 60;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type KeyGetter = ReturnType<typeof createLocalJWKSet>;

/**
 * R-AUTH-04: the team's keys, held in memory per isolate for at most 10 minutes.
 * An unknown `kid` forces one refetch, at most once a minute; with no usable keys
 * every verification fails, so a JWKS outage denies (INV-1).
 */
export class JwksCache {
  private keys: KeyGetter | undefined;
  private fetchedAt = -Infinity;
  private lastRefetchAt = -Infinity;
  private lastFailureAt = -Infinity;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** jose key resolver: cached keys first, one rate-limited refetch on a miss. */
  readonly getKey: JWTVerifyGetKey = async (header, token) => {
    if (!this.keys || this.now() - this.fetchedAt > JWKS_MAX_AGE_MS) {
      this.keys = undefined;
      await this.refresh(true);
    }
    try {
      return await this.current()(header, token);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
      // Key rotation: the signing key may be newer than our copy.
      if (!(await this.refresh(false))) throw error;
      return this.current()(header, token);
    }
  };

  private current(): KeyGetter {
    if (!this.keys) throw new IdentityError('no signing keys available');
    return this.keys;
  }

  /**
   * Returns whether a fetch was attempted. `force` (empty or stale cache) skips the
   * kid cooldown, but not after a failed load: during a JWKS outage requests are
   * denied at once instead of each waiting on its own fetch.
   */
  private async refresh(force: boolean): Promise<boolean> {
    if (this.pending) {
      await this.pending;
      return true;
    }
    if (this.now() - this.lastFailureAt < REFETCH_COOLDOWN_MS) return false;
    if (!force) {
      if (this.now() - this.lastRefetchAt < REFETCH_COOLDOWN_MS) return false;
      this.lastRefetchAt = this.now();
    }
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    await this.pending;
    return true;
  }

  private async load(): Promise<void> {
    try {
      const response = await this.fetcher(this.url, {
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      const body = response.ok ? ((await response.json()) as JSONWebKeySet) : undefined;
      if (Array.isArray(body?.keys)) {
        this.keys = createLocalJWKSet(body);
        this.fetchedAt = this.now();
        return;
      }
    } catch {
      // Falls through: a failed fetch keeps any keys still within their 10 minutes.
    }
    this.lastFailureAt = this.now();
  }
}

/** `my-team`, `my-team.cloudflareaccess.com` or its https URL, as an origin. */
export function teamOrigin(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/+$/, '');
  const host = trimmed.replace(/^https:\/\//i, '');
  const full = host.includes('.') ? host : `${host}.cloudflareaccess.com`;
  if (!/^[a-z0-9.-]+$/i.test(full)) throw new IdentityError('ACCESS_TEAM_DOMAIN is not a hostname');
  return `https://${full.toLowerCase()}`;
}

function assertion(request: Request): string | undefined {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header;
  // R-AUTH-03: some WebSocket clients don't forward the header, so only the
  // upgrade may fall back to the Access cookie.
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return undefined;
  const cookies = request.headers.get('cookie') ?? '';
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'CF_Authorization') return value.join('=') || undefined;
  }
  return undefined;
}

const caches = new Map<string, JwksCache>();

export interface AccessIdentityOptions {
  teamDomain: string | undefined;
  audience: string | undefined;
  fetch?: Fetch;
  now?: () => number;
}

/** R-AUTH-03: Cloudflare Access JWT verifier. `Cf-Access-Authenticated-User-Email` is never read. */
export class AccessIdentityProvider implements IdentityProvider {
  private readonly issuer: string | undefined;
  private readonly jwks: JwksCache | undefined;

  constructor(private readonly options: AccessIdentityOptions) {
    if (!options.teamDomain?.trim() || !options.audience?.trim()) return;
    try {
      this.issuer = teamOrigin(options.teamDomain);
    } catch {
      return; // a malformed team domain verifies nobody, like a missing one
    }
    const url = `${this.issuer}/cdn-cgi/access/certs`;
    if (options.fetch) {
      this.jwks = new JwksCache(url, options.fetch, options.now);
    } else {
      // One cache per isolate and team, shared by every request's context.
      let cache = caches.get(url);
      if (!cache) caches.set(url, (cache = new JwksCache(url)));
      this.jwks = cache;
    }
  }

  async requireIdentity(request: Request): Promise<VerifiedIdentity> {
    // R-AUTH-05: a missing team domain or AUD means nobody is verified.
    if (!this.issuer || !this.jwks || !this.options.audience) {
      throw new IdentityError('Access is not configured');
    }
    const token = assertion(request);
    if (!token) throw new IdentityError('no Access assertion');

    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks.getKey, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.options.audience.trim(),
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ['exp', 'sub'],
        ...(this.options.now ? { currentDate: new Date(this.options.now()) } : {}),
      }));
    } catch (error) {
      // The jose message names only the failed check, never a claim value.
      const reason = error instanceof errors.JOSEError ? error.code : 'unverifiable';
      throw new IdentityError(`Access assertion rejected: ${reason}`);
    }

    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!email) throw new IdentityError('Access assertion has no email');
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new IdentityError('Access assertion has no subject');
    }
    // `requiredClaims` made `exp` present and jose checked it is a number.
    return { email, subject: payload.sub, expiresAt: payload.exp! * 1000 };
  }
}
