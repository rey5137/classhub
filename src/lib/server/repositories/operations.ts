import { eq, sql } from 'drizzle-orm';
import { r2Operations } from '../db/schema';
import type { Database, DatabaseBatch } from '../ports/database';

export interface MonthOperations {
  month: string;
  classA: number;
  classB: number;
}

/** R-MEM-18: adds to each month's counters in one batch; a month's first count inserts its row. */
export async function addOperations(database: Database, rows: MonthOperations[], now: number) {
  const writes = rows
    .filter((row) => row.classA > 0 || row.classB > 0)
    .map((row) =>
      database.db
        .insert(r2Operations)
        .values({ ...row, updatedAt: now })
        .onConflictDoUpdate({
          target: r2Operations.month,
          set: {
            classA: sql`${r2Operations.classA} + ${row.classA}`,
            classB: sql`${r2Operations.classB} + ${row.classB}`,
            updatedAt: now,
          },
        }),
    );
  if (writes.length) await database.batch(writes as unknown as DatabaseBatch);
}

export async function readOperations(database: Database, month: string): Promise<MonthOperations> {
  const [row] = await database.db
    .select({
      month: r2Operations.month,
      classA: r2Operations.classA,
      classB: r2Operations.classB,
    })
    .from(r2Operations)
    .where(eq(r2Operations.month, month))
    .limit(1);
  return row ?? { month, classA: 0, classB: 0 };
}
