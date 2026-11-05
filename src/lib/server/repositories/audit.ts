import { sql, type SQL } from 'drizzle-orm';
import { auditEvents } from '../db/schema';
import { uuidv7 } from '../ids';
import type { DatabaseHandle } from '../ports/database';

export interface AuditEvent {
  actorId: string | null;
  action: string;
  entityType: 'user' | 'invite';
  entityId: string;
  createdAt: number;
}

/** §5.2: ids and an action only, never an email, content or contact payload (INV-5). */
export function auditInsert(db: DatabaseHandle, event: AuditEvent) {
  return db.insert(auditEvents).values({ id: uuidv7(event.createdAt), ...event });
}

/** The same row, written only while `condition` holds, so a guarded change and its audit agree. */
export function auditInsertWhere(db: DatabaseHandle, event: AuditEvent, condition: SQL) {
  return db
    .insert(auditEvents)
    .select(
      sql`select ${uuidv7(event.createdAt)}, ${event.actorId}, ${event.action}, ${event.entityType}, ${event.entityId}, ${event.createdAt} where ${condition}`,
    );
}
