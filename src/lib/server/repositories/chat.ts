import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CHAT_ROOM_ID } from '../../contracts/chat';
import { FEATURES_KEY } from '../../contracts/settings';
import { SEAT_LIMIT } from '../../shared/seats';
import { chatMessages, profileContacts, siteSettings, users } from '../db/schema';
import type { Database } from '../ports/database';
import type { ProfileOwner } from '../services/projection';
import { auditInsertWhere } from './audit';
import { afterKey, beforeKey } from './chat-archive';
import { withAuthor } from './discussions';
import { SETUP_STATE_KEY, type SettingRows } from './settings';

// §9, R-DB-07: the one room's messages, keyset-paged on `(created_at, id)`, the
// conditional idempotent insert with its broadcast authorization (R-CHAT-05, 16) and
// guarded tombstones (R-CHAT-03).

/** R-CHAT-16: under D1's 100 bound variables, and the seat limit (R-AUTH-19) keeps members within it. */
export const AUTHORIZE_MAX_MEMBERS = SEAT_LIMIT;

export interface ChatRow {
  id: string;
  authorId: string;
  body: string;
  createdAt: number;
  deletedAt: number | null;
  author: ProfileOwner;
}

function selectMessages(database: Database) {
  return database.db
    .select({
      id: chatMessages.id,
      authorId: chatMessages.senderId,
      body: chatMessages.body,
      createdAt: chatMessages.createdAt,
      deletedAt: chatMessages.deletedAt,
      displayName: users.displayName,
      status: users.status,
      preferredName: users.preferredName,
      avatarMediaId: users.avatarMediaId,
      deletionRequestedAt: users.deletionRequestedAt,
      visibilityJson: profileContacts.visibilityJson,
    })
    .from(chatMessages)
    .innerJoin(users, eq(users.id, chatMessages.senderId))
    .leftJoin(
      profileContacts,
      eq(
        profileContacts.userId,
        sql`case when ${users.avatarMediaId} is not null then ${users.id} end`,
      ),
    );
}

type SelectedMessage = Awaited<ReturnType<ReturnType<typeof selectMessages>['limit']>>[number];

const selectedMessageSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  body: z.string(),
  createdAt: z.number(),
  deletedAt: z.number().nullable(),
  displayName: z.string(),
  status: z.enum(['invited', 'active', 'suspended']),
  preferredName: z.string().nullable(),
  avatarMediaId: z.string().nullable(),
  deletionRequestedAt: z.number().nullable(),
  visibilityJson: z.string().nullable(),
});

function toChatRow(row: SelectedMessage): ChatRow {
  return withAuthor(row);
}

export interface SendInput {
  id: string;
  senderId: string;
  clientNonce: string;
  body: string;
  now: number;
}

/** What the batch says about who may still receive the broadcast (R-CHAT-16). */
export interface Authorization {
  activeIds: ReadonlySet<string>;
  settings: SettingRows;
}

export interface SendResult {
  /** False for a retried nonce (the row already existed) or a refused sender. */
  inserted: boolean;
  /** The committed row for `(sender, nonce)`, or undefined when the sender is not active. */
  row: ChatRow | undefined;
  /** Null when the read came back unusable: save and ack, but broadcast nothing. */
  authorization: Authorization | null;
}

const activeRowsSchema = z.array(z.object({ id: z.string() }));
const settingRowsSchema = z.array(z.object({ key: z.string(), value: z.string() }));

/**
 * R-CHAT-05, R-CHAT-16, INV-8: one atomic batch. The insert runs only while the sender
 * is active and does nothing for a nonce already stored; the row is read back by
 * `(sender, nonce)`, so a retry returns the original; then the connected members still
 * active and the setup and feature rows. Throws when D1 fails (nothing is known saved).
 */
export async function sendMessage(
  database: Database,
  input: SendInput,
  connectedIds: readonly string[],
): Promise<SendResult> {
  const senderActive = sql`exists (select 1 from ${users} where ${users.id} = ${input.senderId} and ${users.status} = 'active')`;
  // The caller picks which ids fit, so it knows exactly whom the read covered.
  if (connectedIds.length > AUTHORIZE_MAX_MEMBERS) throw new Error('too many members to authorize');
  const [inserted, readBack, active, settings] = await database.batch([
    database.db
      .insert(chatMessages)
      .select(
        sql`select ${input.id}, ${CHAT_ROOM_ID}, ${input.senderId}, ${input.clientNonce}, ${input.body}, ${input.now}, ${null}, ${null} where ${senderActive}`,
      )
      .onConflictDoNothing({ target: [chatMessages.senderId, chatMessages.clientNonce] }),
    selectMessages(database)
      .where(
        and(
          eq(chatMessages.senderId, input.senderId),
          eq(chatMessages.clientNonce, input.clientNonce),
        ),
      )
      .limit(1),
    database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, 'active'), inArray(users.id, [...connectedIds])))
      .limit(AUTHORIZE_MAX_MEMBERS),
    database.db
      .select({ key: siteSettings.key, value: siteSettings.valueJson })
      .from(siteSettings)
      .where(inArray(siteSettings.key, [SETUP_STATE_KEY, FEATURES_KEY]))
      .limit(2),
  ]);

  const stored = selectedMessageSchema
    .array()
    .max(1)
    .parse(readBack?.rows ?? []);
  const activeRows = activeRowsSchema.safeParse(active?.rows);
  const settingRows = settingRowsSchema.safeParse(settings?.rows);
  return {
    inserted: (inserted?.changes ?? 0) > 0,
    row: stored[0] ? toChatRow(stored[0] as SelectedMessage) : undefined,
    authorization:
      activeRows.success && settingRows.success
        ? {
            activeIds: new Set(activeRows.data.map((row) => row.id)),
            settings: new Map(settingRows.data.map((row) => [row.key, row.value])),
          }
        : null,
  };
}

/** R-CHAT-17: the newest persisted message (tombstones included), or null. */
export async function newestMessageId(database: Database): Promise<string | null> {
  const [row] = await database.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.roomId, CHAT_ROOM_ID))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1);
  return row?.id ?? null;
}

export interface MessageKey {
  id: string;
  createdAt: number;
}

export async function findMessageKey(
  database: Database,
  id: string,
): Promise<MessageKey | undefined> {
  const [row] = await database.db
    .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, id), eq(chatMessages.roomId, CHAT_ROOM_ID)))
    .limit(1);
  return row;
}

/**
 * R-CHAT-10, R-CHAT-11: up to `limit` messages before or after `key` (the newest when
 * none), oldest first. `limit + 1` rows are read so the caller knows if more remain.
 */
export async function listMessages(
  database: Database,
  position: { before?: MessageKey; after?: MessageKey },
  limit: number,
): Promise<ChatRow[]> {
  const { before, after } = position;
  const room = eq(chatMessages.roomId, CHAT_ROOM_ID);
  if (after) {
    const rows = await selectMessages(database)
      .where(and(room, afterKey(after)))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
      .limit(limit + 1);
    return rows.map(toChatRow);
  }
  const rows = await selectMessages(database)
    .where(before ? and(room, beforeKey(before)) : room)
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit + 1);
  return rows.map(toChatRow).reverse();
}

export async function findLiveMessage(
  database: Database,
  id: string,
): Promise<ChatRow | undefined> {
  const [row] = await selectMessages(database)
    .where(
      and(
        eq(chatMessages.id, id),
        eq(chatMessages.roomId, CHAT_ROOM_ID),
        isNull(chatMessages.deletedAt),
      ),
    )
    .limit(1);
  return row ? toChatRow(row) : undefined;
}

/** R-CHAT-03, R-DB-08: body cleared and `deleted_at` set; an admin's delete is audited. */
export async function tombstoneMessage(
  database: Database,
  row: ChatRow,
  actorId: string,
  now: number,
): Promise<boolean> {
  const live = and(eq(chatMessages.id, row.id), isNull(chatMessages.deletedAt))!;
  const tombstone = database.db.update(chatMessages).set({ body: '', deletedAt: now }).where(live);
  // The audit row goes first, while `live` still holds.
  const results =
    row.authorId !== actorId
      ? await database.batch([
          auditInsertWhere(
            database.db,
            {
              actorId,
              action: 'chat.delete',
              entityType: 'chat_message',
              entityId: row.id,
              createdAt: now,
            },
            sql`exists (select 1 from ${chatMessages} where ${live})`,
          ),
          tombstone,
        ])
      : await database.batch([tombstone]);
  return (results.at(-1)?.changes ?? 0) > 0;
}
