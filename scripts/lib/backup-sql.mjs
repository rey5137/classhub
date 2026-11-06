// The two statements `backup` sends through `cf.mjs d1-query` that cf.mjs pins to this exact
// text (R-BAK-09, INV-7): nothing else can mint "a verified backup".

/** The one INSERT cf.mjs accepts for `backup_runs`. */
export const BACKUP_RUNS_INSERT =
  'INSERT INTO backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) VALUES (?, ?, ?, ?, ?, ?)';

/** D1's own clock in ms (schema_meta always holds rows), so `verified_at` ignores the admin's clock. */
export const D1_CLOCK_SELECT =
  "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms FROM schema_meta LIMIT 1";

/** R-BAK-06: restore empties `push_subscriptions` after importing SQL and before setting `setup_state = 'locked'`. */
export const RESTORE_CLEAR_PUSH_SUBSCRIPTIONS = 'DELETE FROM push_subscriptions';
