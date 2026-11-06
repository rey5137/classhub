import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { rateEvents } from '../db/schema';
import type { Database } from '../ports/database';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** R-AUTH-21 limits held in `rate_events`; posts, comments and uploads join with their features. */
export const RATE_LIMITS = {
  post: { limit: 10, windowMs: MINUTE },
  profile: { limit: 20, windowMs: HOUR },
  invite: { limit: 30, windowMs: HOUR },
} as const;

export type RateLimitKind = keyof typeof RATE_LIMITS;

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * One event for `memberId` in the `kind` bucket, refused past the limit. The count
 * and the insert are one guarded statement, so concurrent requests cannot both take
 * the last slot; the bucket's expired events are pruned in the same batch (§2).
 */
export async function takeRateLimit(
  database: Database,
  kind: RateLimitKind,
  memberId: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const { limit, windowMs } = RATE_LIMITS[kind];
  const bucket = `${kind}:${memberId}`;
  const since = now - windowMs;
  const [, taken] = await database.batch([
    database.db
      .delete(rateEvents)
      .where(and(eq(rateEvents.bucket, bucket), lte(rateEvents.at, since))),
    database.db
      .insert(rateEvents)
      .select(
        sql`select ${bucket}, ${now} where (select count(*) from ${rateEvents} where ${rateEvents.bucket} = ${bucket} and ${rateEvents.at} > ${since}) < ${limit}`,
      ),
  ]);
  if ((taken?.changes ?? 0) > 0) return { ok: true };

  const oldest = await database.db
    .select({ at: rateEvents.at })
    .from(rateEvents)
    .where(and(eq(rateEvents.bucket, bucket), gt(rateEvents.at, since)))
    .orderBy(asc(rateEvents.at))
    .limit(1);
  const freesAt = (oldest[0]?.at ?? now) + windowMs;
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now) / 1000)) };
}
