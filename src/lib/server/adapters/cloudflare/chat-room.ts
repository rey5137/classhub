import type { D1Database } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { CONTEXT_HEADER, verifyContext } from '../../internal-context';
import {
  attachmentOf,
  ChatRoomCore,
  type RoomSocket,
  type SocketAttachment,
} from '../../services/chat-room';
import { createD1Database } from './d1-database';
import { createCloudflarePushTransport, type PushServiceBinding } from './push-transport';
import { ORIGIN_PARAM } from './realtime-hub';

export type ChatRoomEnv = Record<string, unknown>;

/** The site origin the hub put on the internal URL, kept only when it is an `https://` origin (R-NTF-01). */
function httpsOrigin(roomUrl: string): string | undefined {
  const value = new URL(roomUrl).searchParams.get(ORIGIN_PARAM);
  if (!value || !URL.canParse(value)) return undefined;
  const origin = new URL(value);
  return origin.protocol === 'https:' && origin.origin === value ? value : undefined;
}

// Transport only (INV-2 / D5): chat history lives in D1, so the room writes nothing to
// its own storage (AC-CHAT-11). The SQLite-backed class exists because Workers Free
// requires it (R-CHAT-08). No public route reaches it: the Worker's `/api/v1/chat/ws`
// forwards an upgrade with a signed context (R-CHAT-04), and suspension and deletion
// arrive as RPC calls from the Worker's own binding.
export class ChatRoom extends DurableObject<ChatRoomEnv> {
  private readonly room: ChatRoomCore;
  /** One wrapper per socket, so the core can compare them; the attachment never changes after accept. */
  private readonly wrappers = new WeakMap<WebSocket, RoomSocket>();

  constructor(ctx: DurableObjectState, env: ChatRoomEnv) {
    super(ctx, env);
    const vapidPublicKey =
      typeof env.VAPID_PUBLIC_KEY === 'string' ? env.VAPID_PUBLIC_KEY.trim() : '';
    const vapidPrivateKey =
      typeof env.VAPID_PRIVATE_KEY === 'string' ? env.VAPID_PRIVATE_KEY.trim() : '';
    // Rebuilt on every wake from hibernation, so buckets and presence may reset (R-CHAT-08).
    this.room = new ChatRoomCore({
      database: createD1Database(env.DB as D1Database),
      sockets: () => this.ctx.getWebSockets().map((socket) => this.wrap(socket)),
      push: createCloudflarePushTransport(env.PUSH as PushServiceBinding | undefined),
      ...(vapidPublicKey && vapidPrivateKey
        ? { vapid: { publicKey: vapidPublicKey, privateKey: vapidPrivateKey } }
        : {}),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }

  private wrap(socket: WebSocket): RoomSocket {
    let wrapper = this.wrappers.get(socket);
    if (!wrapper) {
      wrapper = {
        attachment: socket.deserializeAttachment() as SocketAttachment,
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      };
      this.wrappers.set(socket, wrapper);
    }
    return wrapper;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 426 });
    }
    const now = Date.now();
    const context = await verifyContext(
      request.headers.get(CONTEXT_HEADER),
      typeof this.env.INTERNAL_CONTEXT_KEY === 'string' ? this.env.INTERNAL_CONTEXT_KEY : undefined,
      now,
    );
    if (!context) return new Response(null, { status: 403 });

    const { 0: client, 1: server } = new WebSocketPair();
    // R-CHAT-07: the Hibernation API; the room may sleep between frames.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachmentOf(context, now, httpsOrigin(request.url)));
    await this.room.opened(this.wrap(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.room.message(this.wrap(socket), message);
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    // 1005, 1006 and 1015 describe a close without a frame and may not be sent back.
    const reply = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
    try {
      socket.close(reply, 'closed');
    } catch {
      // Already closed on the other side.
    }
    this.room.closed(this.wrap(socket));
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.room.closed(this.wrap(socket));
  }

  /** R-CHAT-09: from `RealtimeHub.disconnectMember`. */
  async disconnectMember(memberId: string): Promise<void> {
    this.room.disconnectMember(memberId);
  }

  /** R-CHAT-03: from `RealtimeHub.notify`. */
  async messageDeleted(id: string): Promise<void> {
    this.room.deleted(id);
  }
}
