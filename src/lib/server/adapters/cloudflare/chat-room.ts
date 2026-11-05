import { DurableObject } from 'cloudflare:workers';

export type ChatRoomEnv = Record<string, unknown>;

// Transport only (INV-2 / D5): chat history lives in D1, so the room owns no
// tables. Slice 4a adds the WebSocket handshake; until then it refuses work.
export class ChatRoom extends DurableObject<ChatRoomEnv> {
  constructor(ctx: DurableObjectState, env: ChatRoomEnv) {
    super(ctx, env);
  }

  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
