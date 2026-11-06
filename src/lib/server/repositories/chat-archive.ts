import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { chatArchives, chatMessages } from '../db/schema';
import { uuidv7 } from '../ids';
import type { Database } from '../ports/database';
import { sha256Hex } from '../sha256';

// R-CHAT-13, 14: chat retention. Candidates and archive ranges are keyset bounds on
// `(created_at, id)`, the order history pages in (R-DB-07), so a range names exactly the rows
// it covers on every driver. Shared by `export-chat`, `prune-chat` and the /admin banner.

const DAY = 86_400_000;
// Rows per read; a remote REST response stays small.
const PAGE = 1_000;

export interface RetentionPolicy {
  retainDays: number;
  maxMessages: number;
}

export interface ChatKey {
  createdAt: number;
  id: string;
}

/** One archived message: the columns `restore --chat` needs to insert it back (R-CHAT-15). */
export const archiveRecordSchema = z
  .object({
    id: z.string().min(1),
    roomId: z.string().min(1),
    senderId: z.string().min(1),
    clientNonce: z.string().min(1),
    body: z.string(),
    createdAt: z.number().int(),
    editedAt: z.number().int().nullable(),
  })
  .strict();
export type ArchiveRecord = z.infer<typeof archiveRecordSchema>;

export interface CandidateRange {
  from: ChatKey;
  to: ChatKey;
  /** The `file_name` R-CHAT-14 names the range by. */
  fileName: string;
  records: ArchiveRecord[];
}

export function compareKeys(a: ChatKey, b: ChatKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function afterKey(key: ChatKey): SQL {
  return or(
    gt(chatMessages.createdAt, key.createdAt),
    and(eq(chatMessages.createdAt, key.createdAt), gt(chatMessages.id, key.id)),
  )!;
}

/** Rows strictly before `key` in `(created_at, id)` order. */
export function beforeKey(key: ChatKey): SQL {
  return or(
    lt(chatMessages.createdAt, key.createdAt),
    and(eq(chatMessages.createdAt, key.createdAt), lt(chatMessages.id, key.id)),
  )!;
}

function atOrAfter(key: ChatKey): SQL {
  return or(
    gt(chatMessages.createdAt, key.createdAt),
    and(eq(chatMessages.createdAt, key.createdAt), gte(chatMessages.id, key.id)),
  )!;
}

function atOrBefore(key: ChatKey): SQL {
  return or(
    lt(chatMessages.createdAt, key.createdAt),
    and(eq(chatMessages.createdAt, key.createdAt), lte(chatMessages.id, key.id)),
  )!;
}

/** Rows with `from <= (created_at, id) <= to`. */
export function inRange(from: ChatKey, to: ChatKey): SQL {
  return and(atOrAfter(from), atOrBefore(to))!;
}

export function archiveFileName(from: ChatKey, to: ChatKey): string {
  return `chat/${from.id}_${to.id}.ndjson.age`;
}

/** The newest row a verified archive covers, purged or not: everything up to it is archived. */
export async function archivedThrough(database: Database): Promise<ChatKey | null> {
  const [row] = await database.db
    .select({ createdAt: chatArchives.rangeEnd, id: chatArchives.toId })
    .from(chatArchives)
    .where(isNotNull(chatArchives.verifiedAt))
    .orderBy(desc(chatArchives.rangeEnd), desc(chatArchives.toId))
    .limit(1);
  return row ?? null;
}

const newestFirst = [desc(chatMessages.createdAt), desc(chatMessages.id)] as const;

/** R-CHAT-13: the newest message older than `retainDays`. One indexed row. */
async function newestByAge(database: Database, policy: RetentionPolicy, now: number) {
  const [row] = await database.db
    .select({ createdAt: chatMessages.createdAt, id: chatMessages.id })
    .from(chatMessages)
    .where(lt(chatMessages.createdAt, now - policy.retainDays * DAY))
    .orderBy(...newestFirst)
    .limit(1);
  return row ?? null;
}

/** R-CHAT-13: the newest message beyond the newest `maxMessages`, read through the index. */
async function newestByCount(database: Database, policy: RetentionPolicy) {
  const [row] = await database.db
    .select({ createdAt: chatMessages.createdAt, id: chatMessages.id })
    .from(chatMessages)
    .orderBy(...newestFirst)
    .limit(1)
    .offset(policy.maxMessages);
  return row ?? null;
}

const beyond = (key: ChatKey | null, covered: ChatKey | null): key is ChatKey =>
  key !== null && (covered === null || compareKeys(key, covered) > 0);

/**
 * R-CHAT-13: the newest candidate not yet in a verified archive, or null. Candidates are a
 * prefix of the timeline (old by age, or beyond the newest `maxMessages`), so the newest of the
 * two limits bounds them all.
 */
export async function uncoveredCandidatesThrough(
  database: Database,
  policy: RetentionPolicy,
  now: number,
): Promise<ChatKey | null> {
  const covered = await archivedThrough(database);
  const byAge = await newestByAge(database, policy, now);
  const byCount = await newestByCount(database, policy);
  const newest =
    byAge && byCount ? (compareKeys(byAge, byCount) >= 0 ? byAge : byCount) : (byAge ?? byCount);
  return beyond(newest, covered) ? newest : null;
}

/**
 * R-CHAT-14: /admin's *chat over retention* banner. The age read is one row. The count read
 * walks up to `maxMessages + 1` index entries (about 30 K rows read, R-BUD-01: admin-only, small
 * against the daily allowance) and is skipped when the age read already shows the banner.
 */
export async function chatOverRetention(
  database: Database,
  policy: RetentionPolicy,
  now: number,
): Promise<boolean> {
  const covered = await archivedThrough(database);
  if (beyond(await newestByAge(database, policy, now), covered)) return true;
  return beyond(await newestByCount(database, policy), covered);
}

interface StoredRow extends ArchiveRecord {
  deletedAt: number | null;
}

/** Every row matching `start` up to `through`, oldest first, paged on the keyset. */
async function rowsThrough(
  database: Database,
  start: SQL | undefined,
  through: ChatKey,
): Promise<StoredRow[]> {
  const rows: StoredRow[] = [];
  let cursor: ChatKey | null = null;
  for (;;) {
    const page: StoredRow[] = await database.db
      .select({
        id: chatMessages.id,
        roomId: chatMessages.roomId,
        senderId: chatMessages.senderId,
        clientNonce: chatMessages.clientNonce,
        body: chatMessages.body,
        createdAt: chatMessages.createdAt,
        editedAt: chatMessages.editedAt,
        deletedAt: chatMessages.deletedAt,
      })
      .from(chatMessages)
      .where(and(cursor ? afterKey(cursor) : start, atOrBefore(through)))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
      .limit(PAGE);
    rows.push(...page);
    if (page.length < PAGE) return rows;
    cursor = page.at(-1)!;
  }
}

/**
 * R-CHAT-15, R-PROF-11: a deleted message (a tombstone, or one a completed deletion request
 * removed) has no body to keep, so archives omit it; pruning still removes its row.
 */
function toRecords(rows: StoredRow[]): ArchiveRecord[] {
  return rows
    .filter((row) => row.deletedAt === null)
    .map(({ id, roomId, senderId, clientNonce, body, createdAt, editedAt }) => ({
      id,
      roomId,
      senderId,
      clientNonce,
      body,
      createdAt,
      editedAt,
    }));
}

/**
 * R-CHAT-13, 14: the rows still to archive, oldest first, one range per UTC month, so later
 * candidates from an already archived month go in a new file.
 */
export async function exportCandidates(
  database: Database,
  policy: RetentionPolicy,
  now: number,
): Promise<CandidateRange[]> {
  const through = await uncoveredCandidatesThrough(database, policy, now);
  if (!through) return [];
  const months = new Map<string, StoredRow[]>();
  const covered = await archivedThrough(database);
  for (const row of await rowsThrough(database, covered ? afterKey(covered) : undefined, through)) {
    const month = new Date(row.createdAt).toISOString().slice(0, 7);
    const rows = months.get(month);
    if (rows) rows.push(row);
    else months.set(month, [row]);
  }
  return [...months.values()].map((rows) => {
    const from = { createdAt: rows[0]!.createdAt, id: rows[0]!.id };
    const to = { createdAt: rows.at(-1)!.createdAt, id: rows.at(-1)!.id };
    return { from, to, fileName: archiveFileName(from, to), records: toRecords(rows) };
  });
}

/** R-CHAT-14: re-reads one range as it is now, for the verification. */
export async function rangeRecords(
  database: Database,
  from: ChatKey,
  to: ChatKey,
): Promise<ArchiveRecord[]> {
  return toRecords(await rowsThrough(database, atOrAfter(from), to));
}

/** The archive's plaintext: one JSON record per line, keys in schema order. */
export function toNdjson(records: ArchiveRecord[]): string {
  return records.map((record) => `${JSON.stringify(archiveRecordSchema.parse(record))}\n`).join('');
}

export function ndjsonSha256(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

/** R-CHAT-14: recorded only after the written file was read back and matched D1. */
export async function recordVerifiedArchive(
  database: Database,
  archive: {
    range: CandidateRange;
    sha256: string;
    exportedAt: number;
    verifiedAt: number;
  },
): Promise<void> {
  const { range } = archive;
  await database.db.insert(chatArchives).values({
    id: uuidv7(archive.verifiedAt),
    fileName: range.fileName,
    fromId: range.from.id,
    toId: range.to.id,
    rangeStart: range.from.createdAt,
    rangeEnd: range.to.createdAt,
    recordCount: range.records.length,
    sha256: archive.sha256,
    exportedAt: archive.exportedAt,
    verifiedAt: archive.verifiedAt,
  });
}

/** R-BUD-08: at most 500 rows per delete statement. */
export const PRUNE_CHUNK = 500;
/**
 * R-BUD-08, R-CHAT-18: a deleted row also writes its four index entries, so 3,000 rows keep
 * one run under 20,000 rows written; the next run resumes.
 */
export const PRUNE_MAX_ROWS = 3_000;

export type PruneResult =
  | { status: 'no-archive' }
  | { status: 'grown'; fileName: string; deleted: number; purged: string[] }
  | { status: 'pruned'; deleted: number; purged: string[]; remaining: boolean };

/**
 * R-CHAT-14, 18 (INV-7): deletes only rows inside a verified, un-purged archive range, in
 * chunks, and sets `purged_at` once the range is empty. Every step is idempotent, so a run
 * that stops anywhere resumes from the rows still there. Stops before deleting from a range
 * whose rows could not all be in its file.
 */
export async function pruneArchived(
  database: Database,
  options: {
    now: () => number;
    pause: () => Promise<void>;
    chunk?: number;
    maxRows?: number;
  },
): Promise<PruneResult> {
  const chunk = Math.min(options.chunk ?? PRUNE_CHUNK, PRUNE_CHUNK);
  const maxRows = options.maxRows ?? PRUNE_MAX_ROWS;
  const archives = await database.db
    .select({
      id: chatArchives.id,
      fileName: chatArchives.fileName,
      fromId: chatArchives.fromId,
      toId: chatArchives.toId,
      rangeStart: chatArchives.rangeStart,
      rangeEnd: chatArchives.rangeEnd,
      recordCount: chatArchives.recordCount,
      exportedAt: chatArchives.exportedAt,
    })
    .from(chatArchives)
    .where(and(isNotNull(chatArchives.verifiedAt), isNull(chatArchives.purgedAt)))
    .orderBy(asc(chatArchives.rangeStart), asc(chatArchives.fromId));
  if (archives.length === 0) return { status: 'no-archive' };

  let deleted = 0;
  const purged: string[] = [];
  for (const archive of archives) {
    const range = inRange(
      { createdAt: archive.rangeStart, id: archive.fromId },
      { createdAt: archive.rangeEnd, id: archive.toId },
    );
    // A message that reached the range after verification is not in the file: never delete
    // it. Rows deleted before the export were left out (R-CHAT-15); rows deleted since were
    // in the file, so they still count, or a late insert would hide behind a new tombstone.
    // Clock skew can only over-count, which refuses (fails closed).
    const [archived] = await database.db
      .select({ rows: count() })
      .from(chatMessages)
      .where(
        and(
          range,
          or(isNull(chatMessages.deletedAt), gte(chatMessages.deletedAt, archive.exportedAt)),
        ),
      );
    if ((archived?.rows ?? 0) > archive.recordCount)
      return { status: 'grown', fileName: archive.fileName, deleted, purged };
    for (;;) {
      const budget = Math.min(chunk, maxRows - deleted);
      if (budget <= 0) return { status: 'pruned', deleted, purged, remaining: true };
      const oldest = database.db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(range)
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
        .limit(budget);
      const gone = await database.db
        .delete(chatMessages)
        .where(and(range, inArray(chatMessages.id, oldest)))
        .returning({ id: chatMessages.id });
      deleted += gone.length;
      if (gone.length === 0) break;
      await options.pause();
    }
    // R-CHAT-18: the range is empty, so it is purged; a retry finds nothing left to flip.
    await database.db
      .update(chatArchives)
      .set({ purgedAt: options.now() })
      .where(and(eq(chatArchives.id, archive.id), isNull(chatArchives.purgedAt)));
    purged.push(archive.fileName);
  }
  return { status: 'pruned', deleted, purged, remaining: false };
}
