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

// `restore --target new` (R-BAK-06) writes only through the one `--file` import, which ends with
// the three statements below; after it, `cf.mjs d1 execute <restore target>` takes only the
// read-only SELECTs further down, verbatim.

/** R-BAK-06, R-AUTH-25: the new Access application issues new subjects; accounts re-link by email. */
export const RESTORE_CLEAR_ACCESS_SUB =
  'UPDATE users SET access_sub = NULL WHERE access_sub IS NOT NULL';

/** R-BAK-06: the restored site serves nobody until `preflight` and `unlock` run on it. */
export const RESTORE_LOCK_SETUP =
  "INSERT INTO site_settings (key, value_json, updated_by, updated_at) VALUES ('setup_state', '\"locked\"', NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = NULL, updated_at = excluded.updated_at";

/**
 * The import file's first statement, without IF NOT EXISTS (the dump's own CREATEs have it):
 * a second import racing into the same new database fails here instead of merging into the
 * first one's tables. The file's last statement drops it (R-BAK-06).
 */
export const RESTORE_IMPORT_GUARD = 'CREATE TABLE _classhub_restore_guard (x INTEGER)';
export const RESTORE_IMPORT_GUARD_DROP = 'DROP TABLE _classhub_restore_guard';

/** What the import file ends with, in this order (R-BAK-06; R-NTF-11 re-posts subscriptions). */
export const RESTORE_IMPORT_TAIL = [
  RESTORE_CLEAR_PUSH_SUBSCRIPTIONS,
  RESTORE_CLEAR_ACCESS_SUB,
  RESTORE_LOCK_SETUP,
];

/** The user tables of a database; a new restore target has none (`_cf_` tables are D1's own). */
export const RESTORE_TARGET_TABLES =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name";

/** R-BAK-06 integrity: every foreign key resolves when this returns no row. */
export const RESTORE_FOREIGN_KEY_CHECK = 'SELECT * FROM pragma_foreign_key_check()';

/** R-BAK-06 integrity: the media rows whose objects the new bucket must hold. */
export const RESTORE_MEDIA_SELECT =
  'SELECT id, object_key, thumb_key, size_bytes, thumb_size_bytes, sha256, thumb_sha256 FROM media WHERE deleted_at IS NULL ORDER BY id';

/** R-BAK-06: no Access subject survives the import. */
export const RESTORE_ACCESS_SUB_LEFT =
  'SELECT count(*) AS n FROM users WHERE access_sub IS NOT NULL';

/** R-BAK-06: the import ended with the lock. */
export const RESTORE_SETUP_STATE_SELECT =
  "SELECT value_json AS v FROM site_settings WHERE key = 'setup_state'";

/** One table's rows after the import, against the manifest (push_subscriptions: none). @param {string} table */
export const restoreCountSelect = (table) => `SELECT count(*) AS n FROM ${table}`;

const RESTORE_TARGET_READS = [
  RESTORE_TARGET_TABLES,
  RESTORE_FOREIGN_KEY_CHECK,
  RESTORE_MEDIA_SELECT,
  RESTORE_ACCESS_SUB_LEFT,
  RESTORE_SETUP_STATE_SELECT,
];

/**
 * The only statements `cf.mjs d1 execute <restore target>` runs: the pinned reads, verbatim, or
 * restoreCountSelect of a bare table name. Never a write (R-BAK-06, INV-7).
 * @param {string} sql
 */
export function isRestoreTargetRead(sql) {
  return (
    RESTORE_TARGET_READS.includes(sql) ||
    /^SELECT count\(\*\) AS n FROM [a-z_][a-z0-9_]*$/.test(sql)
  );
}

/**
 * R-CHAT-15: `restore --chat` inserts one archived message, only when it is missing and its
 * sender is active without a completed deletion (R-PROF-11: the tombstone email; a suspension,
 * R-PROF-11a's re-applied one included, skips it too), never an update or delete. The one statement `cf.mjs d1-query` takes that names `users`. Params: id, room_id,
 * sender_id, client_nonce, body, created_at, edited_at, sender_id, tombstone email.
 */
export const RESTORE_CHAT_INSERT =
  "INSERT INTO chat_messages (id, room_id, sender_id, client_nonce, body, created_at, edited_at) SELECT ?, ?, ?, ?, ?, ?, ? FROM users WHERE id = ? AND status = 'active' AND auth_email <> ? ON CONFLICT DO NOTHING RETURNING id";
