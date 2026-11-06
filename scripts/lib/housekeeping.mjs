import { siteConfig } from '../../src/lib/config/index.ts';
import { JobRunner } from '../../src/lib/server/services/job-runner.ts';
import { DAY, mediaKeys } from '../../src/lib/server/repositories/media.ts';
import {
  markPurged,
  purgeableMedia,
  reconcileUsage,
  retainedObjectKeys,
} from '../../src/lib/server/repositories/housekeeping.ts';

/**
 * R-MEM-11: the unbounded bucket walk is CLI-only; traffic imports JobRunner alone.
 * @param {string[]} argv
 * @param {import('../../src/lib/server/services/job-runner.ts').JobContext & { writes?: import('../../src/lib/server/services/job-runner.ts').HousekeepingWrites; repairUsage?: (now: number) => Promise<void>; out: (line: string) => void; now?: number }} deps
 */
export async function runHousekeeping(argv, deps) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--reconcile')) {
    deps.out('usage: npm run housekeeping -- [--reconcile]');
    return 1;
  }
  const now = deps.now ?? Date.now();
  await deps.repairUsage?.(now);
  await new JobRunner(deps, deps.writes).run(now);
  if (argv[0] === '--reconcile') await reconcile(deps, now);
  deps.out('housekeeping: complete');
  return 0;
}

/** @param {import('../../src/lib/server/services/job-runner.ts').JobContext & { writes?: import('../../src/lib/server/services/job-runner.ts').HousekeepingWrites; out: (line: string) => void }} deps @param {number} now */
async function reconcile(deps, now) {
  const { database, storage, writes } = deps;
  const cutoff = now - siteConfig.deletedMediaGraceDays * DAY;
  // Finish the purge backlog before resetting usage, so later purges cannot subtract it again.
  for (let batch = 0; ; batch++) {
    if (batch >= 10_000) throw new Error('Housekeeping purge limit exceeded');
    const rows = await purgeableMedia(database, cutoff);
    if (!rows.length) break;
    await storage.delete(rows.flatMap(mediaKeys));
    await (writes?.markPurged ?? markPurged)(
      database,
      rows.map((row) => row.id),
      cutoff,
      now,
    );
  }
  let total = 0;
  for (const prefix of ['media/', 'avatars/', 'staging/']) {
    let cursor;
    const seen = new Set();
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 10_000) throw new Error('Housekeeping listing limit exceeded');
      const page = await storage.list(prefix, cursor);
      for (const object of page.objects) {
        if (!Number.isSafeInteger(object.size) || object.size < 0 || !object.key.startsWith(prefix))
          throw new Error('Invalid bucket listing');
      }
      for (let start = 0; start < page.objects.length; start += 90) {
        const objects = page.objects.slice(start, start + 90);
        const { keep, pending, unrecognised } = await retainedObjectKeys(
          database,
          objects.map((object) => object.key),
          cutoff,
        );
        for (const key of unrecognised) deps.out(`housekeeping: unrecognised object kept: ${key}`);
        const remove = objects.filter((object) => !keep.has(object.key));
        if (remove.length) await storage.delete(remove.map((object) => object.key));
        for (const object of objects) {
          // A pending complete's copies are still counted in reserved_bytes (R-MEM-11).
          if (
            keep.has(object.key) &&
            !pending.has(object.key) &&
            !object.key.startsWith('staging/')
          )
            total += object.size;
          if (!Number.isSafeInteger(total))
            throw new Error('Bucket size exceeds integer precision');
        }
      }
      if (!page.cursor) break;
      if (seen.has(page.cursor)) throw new Error('Housekeeping listing did not advance');
      seen.add(page.cursor);
      cursor = page.cursor;
    }
  }
  await reconcileUsage(database, total, now);
}
