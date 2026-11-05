import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { z } from 'zod';
import * as schema from '../../db/schema';
import type { Database, DatabaseHandle } from '../../ports/database';

export interface RemoteStatement {
  sql: string;
  params: unknown[];
}
const responseSchema = z
  .array(
    z.object({
      success: z.literal(true),
      results: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.unknown())) }),
      meta: z.object({ changes: z.number().int().nonnegative() }).passthrough(),
    }),
  )
  .length(1);

/** CLI-only D1 /raw transport. REST statements do not promise an atomic batch. */
export function createRemoteDatabase(
  request: (statement: RemoteStatement) => Promise<unknown>,
): Database {
  const db = drizzle(
    async (sql, params, method) => {
      const [result] = responseSchema.parse(await request({ sql, params }));
      const rows = result!.results.rows;
      return { rows: method === 'get' ? rows[0] : rows };
    },
    { schema },
  );
  return {
    db: db as unknown as DatabaseHandle,
    async batch() {
      throw new Error('D1 REST does not support atomic batches');
    },
  };
}
