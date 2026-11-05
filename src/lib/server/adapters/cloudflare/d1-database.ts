import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../db/schema';
import {
  normalizeBatchResults,
  type BatchResult,
  type Database,
  type DatabaseBatch,
} from '../../ports/database';

/** D1 adapter. Cloudflare types stay inside this directory (INV-4). */
export function createD1Database(d1: D1Database): Database {
  const db = drizzle(d1, { schema });
  return {
    db,
    async batch<T extends DatabaseBatch>(queries: T): Promise<BatchResult[]> {
      return normalizeBatchResults(await db.batch(queries));
    },
  };
}
