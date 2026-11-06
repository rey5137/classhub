import {
  CHAT_PAGE,
  chatHistoryQuerySchema,
  chatHistorySchema,
  chatMessageIdSchema,
  type ChatHistory,
  type ChatMessage,
} from '../../contracts/chat';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import {
  findLiveMessage,
  findMessageKey,
  listMessages,
  tombstoneMessage,
  type ChatRow,
} from '../repositories/chat';
import type { AdminFailure, AdminResult } from './admin';
import { projectProfile, type Viewer } from './projection';

// §9, §11.2: chat history over HTTP and tombstoning; the live room is chat-room.ts.

const denied: AdminFailure = { ok: false, code: 'forbidden' };

/**
 * What every member may see of a sender: the projection for a viewer who is neither
 * the sender nor an admin (R-PROF-04), so one broadcast frame suits every recipient.
 */
export const EVERY_MEMBER: Viewer = { id: '', role: 'member', displayName: '' };

/** R-CHAT-03, R-PROF-04: a row as a DTO; a tombstone carries no body. */
export function toChatMessage(viewer: Viewer, row: ChatRow): ChatMessage {
  const { id, displayName, avatarMediaId } = projectProfile(viewer, row.author);
  const sender = { id, displayName, ...(avatarMediaId ? { avatarMediaId } : {}) };
  return row.deletedAt === null
    ? { id: row.id, createdAt: row.createdAt, sender, deleted: false, body: row.body }
    : { id: row.id, createdAt: row.createdAt, sender, deleted: true };
}

/** `GET /api/v1/chat/messages` (R-CHAT-10, 11, 17): 50 at a time, oldest first. */
export async function listChatMessages(
  context: AppContext,
  member: Member,
  query: unknown,
): Promise<AdminResult<ChatHistory>> {
  const parsed = chatHistoryQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: false, code: 'validation' };
  const { before, after } = parsed.data;
  const cursorId = before ?? after;
  const key = cursorId ? await findMessageKey(context.database, cursorId) : undefined;
  if (cursorId && !key) {
    return {
      ok: false,
      code: 'validation',
      fields: { [before ? 'before' : 'after']: 'validation' },
    };
  }

  const rows = await listMessages(
    context.database,
    before ? { before: key } : after ? { after: key } : {},
    CHAT_PAGE,
  );
  const more = rows.length > CHAT_PAGE;
  // The extra row is the one furthest from the cursor: the oldest going back, the newest going on.
  const page = more ? (after ? rows.slice(0, CHAT_PAGE) : rows.slice(1)) : rows;
  const nextCursor = more ? (after ? page.at(-1)!.id : page[0]!.id) : null;
  return {
    ok: true,
    status: 200,
    body: chatHistorySchema.parse({
      items: page.map((row) => toChatMessage(member, row)),
      nextCursor,
    }),
  };
}

/**
 * `DELETE /api/v1/chat/messages/:id` (R-CHAT-03): the sender or an admin; an unknown,
 * already deleted or someone else's message gets the same refusal. Live sockets hear
 * of it through the hub; a failed notice is caught up on the next history load.
 */
export async function deleteChatMessage(
  context: AppContext,
  member: Member,
  params: unknown,
  now = Date.now(),
): Promise<AdminResult<{ ok: true }>> {
  const path = chatMessageIdSchema.safeParse(params);
  if (!path.success) return denied;
  const row = await findLiveMessage(context.database, path.data.id);
  if (!row || !can(member, 'content.delete', { ownerId: row.authorId })) return denied;
  if (!(await tombstoneMessage(context.database, row, member.id, now))) return denied;
  try {
    await context.realtime.notify({ type: 'message.deleted', id: row.id });
  } catch {
    // Best effort, like disconnectMember (R-CHAT-09): D1 already holds the tombstone.
  }
  return { ok: true, status: 200, body: { ok: true } };
}
