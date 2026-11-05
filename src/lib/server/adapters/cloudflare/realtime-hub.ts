import type { RealtimeHub } from '../../ports/realtime';

/**
 * R-CHAT-09: the Durable Object bridge. Until slice 4a adds the handshake there are
 * no sockets to close, so suspension's call lands here and does nothing; R-CHAT-16
 * is what guarantees delivery stops.
 */
export function createDurableObjectHub(): RealtimeHub {
  return {
    async connect() {
      return new Response(null, { status: 501 });
    },
    async disconnectMember() {},
    async notify() {},
  };
}
