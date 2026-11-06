import type { Database } from '../ports/database';
import type { ObjectStorage } from '../ports/object-storage';
import { addOperations, type MonthOperations } from '../repositories/operations';

// R-MEM-18 / §14: the app's own estimate of R2 operations per UTC month. Class A
// (a single put; a multipart put's create, parts and complete; list) is written for
// every request that made one, so it is exact unless that write fails; Class B (head,
// get) is tallied per isolate and flushed at most once a minute, so a lost isolate
// undercounts it. R2 does not bill DeleteObject or AbortMultipartUpload, so those
// count nothing.

export const CLASS_B_FLUSH_MS = 60_000;

export function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export interface OperationCount {
  classA: number;
  classB: number;
}

/** Counts every billed call on `inner`. */
export function meterStorage(inner: ObjectStorage, count: OperationCount): ObjectStorage {
  return {
    put(key, body, opts) {
      // The adapter reports each billed request: a multipart put is several (R-MEM-18).
      return inner.put(key, body, {
        ...opts,
        onWrite: () => {
          count.classA += 1;
          opts.onWrite?.();
        },
      });
    },
    head(key) {
      count.classB += 1;
      return inner.head(key);
    },
    get(key, opts) {
      count.classB += 1;
      return inner.get(key, opts);
    },
    delete(keys) {
      return inner.delete(keys);
    },
    list(prefix, cursor) {
      count.classA += 1;
      return inner.list(prefix, cursor);
    },
  };
}

/** One isolate's unwritten Class B reads, by month, released at most once per interval. */
export class ClassBTally {
  private pending = new Map<string, number>();
  private windowStart: number | null = null;

  add(reads: number, now: number): void {
    if (reads <= 0) return;
    const month = monthKey(now);
    this.pending.set(month, (this.pending.get(month) ?? 0) + reads);
    this.windowStart ??= now;
  }

  /** The months to write now, or nothing until a minute has passed since the last take. */
  take(now: number): MonthOperations[] {
    if (this.windowStart === null || now - this.windowStart < CLASS_B_FLUSH_MS) return [];
    const rows = [...this.pending].map(([month, classB]) => ({ month, classA: 0, classB }));
    this.pending.clear();
    this.windowStart = null;
    return rows;
  }

  /** A failed write puts its reads back, to go out with the next flush. */
  restore(rows: MonthOperations[], now: number): void {
    for (const row of rows) {
      this.pending.set(row.month, (this.pending.get(row.month) ?? 0) + row.classB);
    }
    if (rows.length) this.windowStart ??= now;
  }
}

const isolateTally = new ClassBTally();

/**
 * One request's operations: its Class A goes to the current month now, its Class B
 * joins the isolate tally, and the tally rides along when its minute is up. Returns
 * null when there is nothing to write.
 */
export function recordOperations(
  database: Database,
  count: OperationCount,
  now: number,
  tally: ClassBTally = isolateTally,
): Promise<void> | null {
  tally.add(count.classB, now);
  const flushed = tally.take(now);
  const month = monthKey(now);
  const rows: MonthOperations[] = flushed.filter((row) => row.month !== month);
  const current = flushed.find((row) => row.month === month)?.classB ?? 0;
  if (count.classA > 0 || current > 0) rows.push({ month, classA: count.classA, classB: current });
  if (!rows.length) return null;
  return addOperations(database, rows, now).catch((error: unknown) => {
    tally.restore(flushed, now);
    throw error;
  });
}
