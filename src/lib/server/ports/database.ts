import type { BatchItem } from 'drizzle-orm/batch';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from '../db/schema';

/** R-PLAT-03/06: services and repositories see only this handle, never D1 or better-sqlite3. */
export type DatabaseHandle = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>;

export type DatabaseBatch = readonly [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];

/** Driver-neutral batch result: writes report `changes`, selects return `rows`. */
export interface BatchResult {
  changes: number;
  rows: unknown[];
}

function normalizeBatchResult(result: unknown): BatchResult {
  if (Array.isArray(result)) return { changes: 0, rows: result };

  const record = (result ?? {}) as {
    changes?: unknown;
    meta?: { changes?: unknown };
    results?: unknown;
  };
  const changes = Number(record.changes ?? record.meta?.changes ?? 0);
  return {
    changes: Number.isFinite(changes) ? changes : 0,
    rows: Array.isArray(record.results) ? record.results : [],
  };
}

/** R-DB-08: adapters hand back this shape so repository code is driver-neutral. */
export function normalizeBatchResults(results: readonly unknown[]): BatchResult[] {
  return results.map(normalizeBatchResult);
}

export interface Database {
  /** Queries are always awaited so the same repository code runs on both drivers. */
  readonly db: DatabaseHandle;
  /** R-DB-08: one atomic unit; the local adapter uses a transaction, D1 uses `batch`. */
  batch<T extends DatabaseBatch>(queries: T): Promise<BatchResult[]>;
}
