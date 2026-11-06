// The real ChatRoom class, so the pool's CHAT_ROOM binding runs it (§9.2).
export { ChatRoom } from '../../src/lib/server/adapters/cloudflare/chat-room';

export default {
  async fetch(): Promise<Response> {
    // The pool needs a Worker entry; these tests import route handlers directly.
    return new Response('not found', { status: 404 });
  },
};
