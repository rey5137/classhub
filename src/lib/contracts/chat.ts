import { z } from 'zod';

// §9.2, R-API-04: the chat socket's frames and the history DTOs, shared by the
// ChatRoom (both adapters), the history routes and the /chat client (4b).

export const CHAT_ROOM_ID = 'main';
export const CHAT_WS_PATH = '/api/v1/chat/ws';
/** R-CHAT-01: counted in code points after trimming, so an emoji is one character. */
export const CHAT_BODY_MAX = 1_000;
/** R-AUTH-22: a frame's UTF-8 size, checked before it is parsed. */
export const CHAT_FRAME_MAX_BYTES = 4_096;
/** R-CHAT-10: one history page. */
export const CHAT_PAGE = 50;

/** R-CHAT-09, R-CHAT-16: no longer authorized (suspended, locked, chat off). */
export const CLOSE_FORBIDDEN = 4003;
/** R-CHAT-16: the Access session behind the socket expired; reload through Access. */
export const CLOSE_REAUTH = 4001;

export const chatBodySchema = z
  .string()
  .trim()
  .refine((body) => body.length > 0 && Array.from(body).length <= CHAT_BODY_MAX, {
    message: 'validation',
  });

// Client → room. `clientNonce` is reused on a retry (R-CHAT-02).
export const sendFrameSchema = z
  .object({ type: z.literal('send'), clientNonce: z.uuid(), body: chatBodySchema })
  .strict();
export const clientFrameSchema = z.discriminatedUnion('type', [sendFrameSchema]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

/** The sender as every member may see them (R-PROF-04): name and, when shared, the avatar. */
export const chatSenderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarMediaId: z.string().optional(),
});

/** R-CHAT-03: a tombstone keeps its place in the timeline but carries no body. */
export const chatMessageSchema = z.discriminatedUnion('deleted', [
  z.object({
    id: z.string(),
    createdAt: z.number().int(),
    sender: chatSenderSchema,
    deleted: z.literal(false),
    body: z.string(),
  }),
  z.object({
    id: z.string(),
    createdAt: z.number().int(),
    sender: chatSenderSchema,
    deleted: z.literal(true),
  }),
]);
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatErrorCodes = [
  'validation',
  'payload_too_large',
  'rate_limited',
  'not_saved',
] as const;
export type ChatErrorCode = (typeof chatErrorCodes)[number];

// Room → client.
export const serverFrameSchema = z.discriminatedUnion('type', [
  /** R-CHAT-17: `lastId` is the newest persisted message, or null in an empty room. */
  z.object({ type: z.literal('hello'), online: z.number().int(), lastId: z.string().nullable() }),
  /** R-CHAT-07: the presence count, sent to everyone on each connect and disconnect. */
  z.object({ type: z.literal('online'), online: z.number().int() }),
  /** R-CHAT-06: only after D1 committed the row; a retried nonce acks the original. */
  z.object({ type: z.literal('ack'), clientNonce: z.string(), message: chatMessageSchema }),
  z.object({ type: z.literal('message'), message: chatMessageSchema }),
  /** R-CHAT-03: a message became a tombstone. */
  z.object({ type: z.literal('deleted'), id: z.string() }),
  z.object({
    type: z.literal('error'),
    code: z.enum(chatErrorCodes),
    clientNonce: z.string().optional(),
  }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

// History (§11.2): `before` pages back from a message, `after` catches up (R-CHAT-11, 17).
export const chatHistoryQuerySchema = z
  .object({ before: z.uuid().optional(), after: z.uuid().optional() })
  .strict()
  .refine((query) => !(query.before && query.after), { message: 'validation' });

/** Items oldest first; `nextCursor` is the id to pass as the same parameter for the next page. */
export const chatHistorySchema = z.object({
  items: z.array(chatMessageSchema),
  nextCursor: z.string().nullable(),
});
export type ChatHistory = z.infer<typeof chatHistorySchema>;

export const chatMessageIdSchema = z.object({ id: z.uuid() });
