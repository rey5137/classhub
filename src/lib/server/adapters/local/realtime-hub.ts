import { signContext, verifyContext } from '../../internal-context';
import type { Database } from '../../ports/database';
import type { PushTransport } from '../../ports/push-transport';
import type { RealtimeHub } from '../../ports/realtime';
import type { VapidKeys } from '../../push';
import { attachmentOf, ChatRoomCore, type RoomSocket } from '../../services/chat-room';
import { pendingUpgrades, TICKET_HEADER, type LocalSocket } from './upgrade-registry';

export interface LocalHubOptions {
  database: Database;
  /** Signer and room share one process, so a random key per process serves unless one is set. */
  contextKey?: string;
  push?: PushTransport;
  vapid?: VapidKeys;
  now?: () => number;
}

function randomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * The in-process hub (§2 adapters, R-PLAT-10): the same room as the Durable Object
 * (services/chat-room.ts) over `ws` sockets from the dev server. `connect` answers the
 * route with a 204 and leaves the signed context on the pending upgrade; the dev
 * server's listener then completes the upgrade and hands the socket over, and the room
 * verifies the context as the Durable Object does (R-CHAT-04).
 */
export function createLocalHub(options: LocalHubOptions): RealtimeHub {
  const contextKey = options.contextKey || randomKey();
  const now = options.now ?? Date.now;
  const sockets = new Set<RoomSocket>();
  const room = new ChatRoomCore({
    database: options.database,
    sockets: () => [...sockets],
    push: options.push,
    vapid: options.vapid,
    now,
  });

  function accept(token: string, socket: LocalSocket, siteOrigin: string | undefined): void {
    let peer: RoomSocket | undefined;
    let closed = false;
    // One step at a time per socket, as the Durable Object delivers them: the hello
    // first, so a frame that arrives while the context is verified waits behind it.
    let queue: Promise<unknown> = (async () => {
      const context = await verifyContext(token, contextKey, now());
      if (closed) return;
      if (!context) return socket.close(1008, 'not authorized');
      peer = {
        attachment: attachmentOf(context, now(), siteOrigin),
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      };
      sockets.add(peer);
      await room.opened(peer);
    })().catch(() => {});
    const next = (step: () => unknown) => {
      queue = queue.then(step).catch(() => {});
    };
    // Listeners go on before any await, so no frame or close is missed.
    socket.onMessage((data) => next(() => peer && room.message(peer, data)));
    socket.onClose(() => {
      closed = true;
      next(() => {
        if (peer && sockets.delete(peer)) room.closed(peer);
      });
    });
  }

  return {
    async connect(request, member) {
      const pending = pendingUpgrades().get(request.headers.get(TICKET_HEADER) ?? '');
      // Only the dev server's upgrade listener creates tickets.
      if (!pending) return new Response(null, { status: 426 });
      const token = await signContext(
        {
          memberId: member.id,
          role: member.role,
          displayName: member.displayName,
          authUntil: member.authUntil,
        },
        contextKey,
        now(),
      );
      // R-NTF-01: a VAPID `sub` must be an `https://` origin; the dev server's http one is left out.
      const origin = new URL(request.url);
      const siteOrigin = origin.protocol === 'https:' ? origin.origin : undefined;
      pending.accept = (socket) => accept(token, socket, siteOrigin);
      return new Response(null, { status: 204 });
    },
    async disconnectMember(memberId) {
      room.disconnectMember(memberId);
    },
    async notify(event) {
      room.deleted(event.id);
    },
  };
}
