import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { CHAT_ROOM_ID } from '../../../contracts/chat';
import { CONTEXT_HEADER, signContext } from '../../internal-context';
import type { RealtimeHub } from '../../ports/realtime';
import type { ChatRoom } from './chat-room';

/** The internal URL the room is fetched on; only the binding can reach it. */
const ROOM_URL = 'https://chat-room.internal/connect';

/**
 * The ChatRoom Durable Object bridge (R-CHAT-04, 09). One room, addressed by name
 * (`main`); tests pass another name to keep their sockets apart.
 */
export function createDurableObjectHub(
  rooms: DurableObjectNamespace<ChatRoom> | undefined,
  contextKey: string | undefined,
  options: { roomName?: string; now?: () => number } = {},
): RealtimeHub {
  const room = () => {
    if (!rooms) throw new Error('missing Durable Object binding: CHAT_ROOM');
    return rooms.get(rooms.idFromName(options.roomName ?? CHAT_ROOM_ID));
  };
  return {
    async connect(_request, member) {
      if (!contextKey) throw new Error('INTERNAL_CONTEXT_KEY is not set');
      const token = await signContext(
        {
          memberId: member.id,
          role: member.role,
          displayName: member.displayName,
          authUntil: member.authUntil,
        },
        contextKey,
        (options.now ?? Date.now)(),
      );
      // A Request built from scratch: no client header (cookie, Access assertion) travels on.
      const response = await room().fetch(ROOM_URL, {
        headers: { upgrade: 'websocket', [CONTEXT_HEADER]: token },
      });
      return response as unknown as Response;
    },
    async disconnectMember(memberId) {
      await room().disconnectMember(memberId);
    },
    async notify(event) {
      await room().messageDeleted(event.id);
    },
  };
}
