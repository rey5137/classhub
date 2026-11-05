import { DurableObject } from 'cloudflare:workers';

import { PROBE_PATH } from './ws-probe';

export type ChatRoomEnv = Record<string, unknown>;

// Transport only (INV-2 / D5): chat history lives in D1, so the room owns no
// tables. Slice 4a adds the WebSocket handshake; until then it refuses work,
// except the temporary R-OPS-16 echo below.
export class ChatRoom extends DurableObject<ChatRoomEnv> {
  constructor(ctx: DurableObjectState, env: ChatRoomEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    // TEMPORARY (R-OPS-16, remove in 4a): an echo socket proving an upgrade passes
    // Access on workers.dev. Reachable only through the Worker's `/__probe/ws`.
    if (
      new URL(request.url).pathname === PROBE_PATH &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    ) {
      const { 0: client, 1: server } = new WebSocketPair();
      // Hibernation API: no timers, the room may sleep between frames (R-CHAT-07).
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not implemented', { status: 501 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    socket.send(message);
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    // 1005, 1006 and 1015 describe a close without a frame and may not be sent back.
    const reply = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
    try {
      socket.close(reply, 'probe closed');
    } catch {
      // Already closed on the other side: nothing left to answer.
    }
  }
}
