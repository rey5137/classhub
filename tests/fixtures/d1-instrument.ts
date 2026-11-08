import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

// Test-only D1 wrappers (AC-BUD-02, AC-BUD-04). Cloudflare types are allowed in
// tests; the app's own files keep them inside the adapter (INV-4).

const NATIVE = Symbol('native');
const QUERY = Symbol('query');

interface Wrapped {
  [NATIVE]: D1PreparedStatement;
  [QUERY]: string;
}

function isWrite(query: string): boolean {
  return /^\s*(insert|update|delete|replace)\b/i.test(query);
}

/** The first row as an object, whichever shape the driver returned. */
function rowValue(row: unknown, column?: string): unknown {
  if (row === undefined || row === null) return null;
  if (column === undefined) return row;
  return (row as Record<string, unknown>)[column] ?? null;
}

export interface RowCounter {
  /** Sum of `meta.rows_read` for every statement since the last reset. */
  rowsRead(): number;
  /** R-BUD-01: rows read by `/admin`'s full-index retention and photo-count scans. */
  adminIndexRowsRead(): number;
  reset(): void;
  database: D1Database;
}

const ADMIN_INDEX_SCAN =
  /^select "created_at", "id" from "chat_messages" order by .* limit \? offset \?$/i;
const ADMIN_PHOTO_COUNT =
  /^select count\(\*\) from "media" where \("media"\."media_type" = \? and "media"\."deleted_at" is null\)/i;

/**
 * AC-BUD-02: counts rows read per request from D1's own `meta.rows_read`.
 */
export function countingD1(d1: D1Database): RowCounter {
  let total = 0;
  let adminIndexTotal = 0;

  const record = (query: string, read: number) => {
    total += read;
    if (ADMIN_INDEX_SCAN.test(query.trim()) || ADMIN_PHOTO_COUNT.test(query.trim())) {
      adminIndexTotal += read;
    }
  };

  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped: Wrapped & {
      bind: (...values: unknown[]) => D1PreparedStatement;
      first: (column?: string) => Promise<unknown>;
      run: <T>() => Promise<D1Result<T>>;
      all: <T>() => Promise<D1Result<T>>;
      raw: (options?: { columnNames?: boolean }) => Promise<unknown>;
    } = {
      [NATIVE]: statement,
      [QUERY]: query,
      bind: (...values) => wrap(statement.bind(...values), query),
      async first(column?: string) {
        const result = await statement.all();
        record(query, result.meta?.rows_read ?? 0);
        return rowValue(result.results[0], column);
      },
      async run<T>() {
        const result = (await statement.run()) as D1Result<T>;
        record(query, result.meta?.rows_read ?? 0);
        return result;
      },
      async all<T>() {
        const result = (await statement.all()) as D1Result<T>;
        record(query, result.meta?.rows_read ?? 0);
        return result;
      },
      async raw(options?: { columnNames?: boolean }) {
        // `raw()` carries no meta, so a read runs a second time as `.all()` for its count (a
        // read is repeatable; the data is the real `raw()` result, same-named columns intact).
        const rows = await statement.raw(options as { columnNames: true });
        // Read the meta first: `total += await …` would add to a stale total when reads overlap.
        if (!isWrite(query)) {
          const read = (await statement.all()).meta?.rows_read ?? 0;
          record(query, read);
        }
        return rows;
      },
    };
    return wrapped as unknown as D1PreparedStatement;
  };

  const database = {
    prepare: (query: string) => wrap(d1.prepare(query), query),
    async batch(statements: D1PreparedStatement[]) {
      const results = await d1.batch(
        statements.map((statement) => (statement as unknown as Wrapped)[NATIVE] ?? statement),
      );
      for (const [index, result] of results.entries()) {
        record(
          (statements[index] as unknown as Wrapped)?.[QUERY] ?? '',
          result.meta?.rows_read ?? 0,
        );
      }
      return results;
    },
    exec: (query: string) => d1.exec(query),
    withSession: (constraint?: unknown) =>
      d1.withSession(constraint as Parameters<D1Database['withSession']>[0]),
    dump: () => d1.dump(),
  } as unknown as D1Database;

  return {
    database,
    rowsRead: () => total,
    adminIndexRowsRead: () => adminIndexTotal,
    reset: () => {
      total = 0;
      adminIndexTotal = 0;
    },
  };
}

/** A D1-style failure, as the platform reports a write it cannot make. */
export function writeFailure(query: string): Error {
  const error = new Error(
    `D1_ERROR: cannot write (${query.trim().split(/\s+/)[0]}): SQLITE_READONLY`,
  );
  error.name = 'D1Error';
  return error;
}

/**
 * AC-BUD-04: every write statement (INSERT/UPDATE/DELETE, or a batch holding one)
 * throws a D1-style error; reads pass through unchanged.
 */
export function writeFailingD1(d1: D1Database): D1Database {
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const fail = () => {
      throw writeFailure(query);
    };
    const wrapped = {
      [NATIVE]: statement,
      [QUERY]: query,
      bind: (...values: unknown[]) => wrap(statement.bind(...values), query),
      first: (column?: string) =>
        isWrite(query) ? fail() : (statement.first(column as never) as Promise<unknown>),
      run: () => (isWrite(query) ? fail() : statement.run()),
      all: () => (isWrite(query) ? fail() : statement.all()),
      raw: (options?: unknown) => (isWrite(query) ? fail() : statement.raw(options as never)),
    };
    return wrapped as unknown as D1PreparedStatement;
  };

  return {
    prepare: (query: string) => wrap(d1.prepare(query), query),
    async batch(statements: D1PreparedStatement[]) {
      const natives = statements.map(
        (statement) => (statement as unknown as Wrapped)[NATIVE] ?? statement,
      );
      const write = statements.find((statement) =>
        isWrite((statement as unknown as Wrapped)[QUERY]),
      );
      if (write) throw writeFailure((write as unknown as Wrapped)[QUERY]);
      return d1.batch(natives);
    },
    exec: (query: string) => {
      if (isWrite(query)) throw writeFailure(query);
      return d1.exec(query);
    },
    withSession: (constraint?: unknown) =>
      d1.withSession(constraint as Parameters<D1Database['withSession']>[0]),
    dump: () => d1.dump(),
  } as unknown as D1Database;
}
