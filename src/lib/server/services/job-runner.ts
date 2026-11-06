import { siteConfig } from '../../config';
import type { Database } from '../ports/database';
import type { ObjectStorage } from '../ports/object-storage';
import {
  expiredReservations,
  markPurged,
  protectedStagingKeys,
  purgeableMedia,
  releaseExpired,
} from '../repositories/housekeeping';
import { DAY, mediaKeys, reservationKeys } from '../repositories/media';
import { claimHousekeeping } from '../repositories/settings';
import { recordOperations } from './operations';

export interface JobContext {
  database: Database;
  storage: Pick<ObjectStorage, 'list' | 'delete'>;
}

export interface HousekeepingWrites {
  releaseExpired: typeof releaseExpired;
  markPurged: typeof markPurged;
}

export class JobRunner {
  constructor(
    private readonly context: JobContext,
    private readonly writes: HousekeepingWrites = { releaseExpired, markPurged },
  ) {}

  async trigger(now = Date.now()): Promise<void> {
    if (!(await claimHousekeeping(this.context.database.db, now))) return;
    const operations = { classA: 0, classB: 0 };
    try {
      await this.run(now, operations);
    } finally {
      // R-MEM-18: the traffic run's lists (deletes are not billed), counted even when a
      // step failed; best effort, so a failed count never hides the run's own error. The CLI calls
      // `run` alone: it writes through the REST allow-list, which has no counter table.
      await recordOperations(this.context.database, operations, now)?.catch(() => undefined);
    }
  }

  async run(now = Date.now(), operations = { classA: 0, classB: 0 }): Promise<void> {
    const { database } = this.context;
    const storage: JobContext['storage'] = {
      list: (prefix, cursor) => {
        operations.classA += 1;
        return this.context.storage.list(prefix, cursor);
      },
      delete: (keys) => this.context.storage.delete(keys),
    };
    const expired = await expiredReservations(database, now);
    await this.writes.releaseExpired(
      database,
      expired.map((row) => row.id),
      now,
    );
    if (expired.length) await storage.delete(expired.flatMap(reservationKeys));

    // Bound traffic work to four pages and twenty keys per query (R-MEM-11, R-DB-07).
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const page = await storage.list('staging/', cursor);
      const orphans: string[] = [];
      for (let start = 0; start < page.objects.length; start += 20) {
        const keys = page.objects.slice(start, start + 20).map((object) => object.key);
        const keep = await protectedStagingKeys(database, keys);
        orphans.push(...keys.filter((key) => !keep.has(key)));
      }
      if (orphans.length) await storage.delete(orphans);
      if (!page.cursor) break;
      if (page.cursor === cursor) throw new Error('Housekeeping listing did not advance');
      cursor = page.cursor;
    }

    const cutoff = now - siteConfig.deletedMediaGraceDays * DAY;
    const deleted = await purgeableMedia(database, cutoff);
    if (deleted.length) {
      await storage.delete(deleted.flatMap(mediaKeys));
      await this.writes.markPurged(
        database,
        deleted.map((row) => row.id),
        cutoff,
        now,
      );
    }
  }
}
