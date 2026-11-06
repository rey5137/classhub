import {
  CHAT_FRAME_MAX_BYTES,
  CLOSE_FORBIDDEN,
  CLOSE_REAUTH,
  clientFrameSchema,
  type ChatErrorCode,
  type ServerFrame,
} from '../../contracts/chat';
import { uuidv7 } from '../ids';
import type { MemberContext } from '../internal-context';
import { logLine } from '../log';
import type { Database } from '../ports/database';
import type { PushTransport } from '../ports/push-transport';
import type { VapidKeys } from '../push';
import { AUTHORIZE_MAX_MEMBERS, newestMessageId, sendMessage } from '../repositories/chat';
import { setupUnlockedIn } from '../repositories/settings';
import { sendChatPush } from './push-service';
import { effectiveSettings } from './settings';
import { EVERY_MEMBER, toChatMessage } from './chat';

// §9.2: the room behind both RealtimeHub adapters (the ChatRoom Durable Object and the
// local `ws` hub). It holds sockets and memory-only buckets, never history (INV-2), and
// sets no timer (R-CHAT-07): everything happens on an inbound frame, open or close.

/** R-CHAT-07: what each socket carries from its verified context (R-CHAT-04). */
export interface SocketAttachment {
  memberId: string;
  role: MemberContext['role'];
  displayName: string;
  connectedAt: number;
  authUntil: number;
  /** R-NTF-01: the `https://` origin the member connected through, the VAPID `sub` of the pushes it triggers. */
  siteOrigin?: string;
}

export interface RoomSocket {
  readonly attachment: SocketAttachment;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface ChatRoomDeps {
  database: Database;
  /** Every socket the room has open, the one being handled included. */
  sockets(): RoomSocket[];
  push?: PushTransport;
  vapid?: VapidKeys;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
}

/** R-CHAT-05: 1 per second, burst 5, per member. */
const BUCKET_SIZE = 5;
const REFILL_MS = 1_000;

export function attachmentOf(
  context: MemberContext,
  now: number,
  siteOrigin?: string,
): SocketAttachment {
  const { memberId, role, displayName, authUntil } = context;
  const attachment: SocketAttachment = { memberId, role, displayName, connectedAt: now, authUntil };
  if (siteOrigin) attachment.siteOrigin = siteOrigin;
  return attachment;
}

function sendFrame(socket: RoomSocket, frame: ServerFrame): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // Closed on the other side mid-broadcast: its close event updates presence.
  }
}

function closeSocket(socket: RoomSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed: nothing left to tell it.
  }
}

/** A nonce worth echoing in an error, so the client can mark that message. */
function nonceOf(value: unknown): string | undefined {
  const nonce = (value as { clientNonce?: unknown } | null)?.clientNonce;
  return typeof nonce === 'string' && nonce.length <= 64 ? nonce : undefined;
}

export class ChatRoomCore {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: ChatRoomDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** After accept: `hello` to the newcomer (R-CHAT-17), the new count to everyone else. */
  async opened(socket: RoomSocket): Promise<void> {
    let lastId: string | null;
    try {
      lastId = await newestMessageId(this.deps.database);
    } catch {
      // Without `lastId` the client could not know what it missed; it reconnects instead.
      closeSocket(socket, 1011, 'unavailable');
      return;
    }
    // The newcomer's context was verified at accept, so only its peers are re-checked.
    const peers = this.live(this.deps.sockets().filter((peer) => peer !== socket));
    sendFrame(socket, { type: 'hello', online: peers.length + 1, lastId });
    for (const peer of peers) sendFrame(peer, { type: 'online', online: peers.length + 1 });
  }

  /** R-CHAT-07: presence is the socket count, re-sent on each disconnect. */
  closed(socket: RoomSocket): void {
    const sockets = this.live(this.deps.sockets().filter((peer) => peer !== socket));
    for (const peer of sockets) sendFrame(peer, { type: 'online', online: sockets.length });
  }

  /**
   * R-CHAT-16: no frame goes to a socket whose Access session has ended; it is closed
   * with 4001 instead (the client reloads through Access). Returns the others.
   */
  private live(sockets: RoomSocket[]): RoomSocket[] {
    const now = this.now();
    return sockets.filter((socket) => {
      if (socket.attachment.authUntil > now) return true;
      closeSocket(socket, CLOSE_REAUTH, 'session expired');
      return false;
    });
  }

  /** R-CHAT-09: best effort; R-CHAT-16 is what guarantees delivery stops. */
  disconnectMember(memberId: string): void {
    for (const socket of this.deps.sockets()) {
      if (socket.attachment.memberId === memberId) {
        closeSocket(socket, CLOSE_FORBIDDEN, 'not authorized');
      }
    }
  }

  /** R-CHAT-03: a tombstone reaches everyone connected; the frame names only the id. */
  deleted(id: string): void {
    for (const socket of this.live(this.deps.sockets())) sendFrame(socket, { type: 'deleted', id });
  }

  private error(socket: RoomSocket, code: ChatErrorCode, clientNonce?: string): void {
    sendFrame(socket, { type: 'error', code, ...(clientNonce ? { clientNonce } : {}) });
  }

  private take(memberId: string, now: number): boolean {
    const bucket = this.buckets.get(memberId) ?? { tokens: BUCKET_SIZE, at: now };
    const tokens = Math.min(BUCKET_SIZE, bucket.tokens + (now - bucket.at) / REFILL_MS);
    const allowed = tokens >= 1;
    this.buckets.set(memberId, { tokens: allowed ? tokens - 1 : tokens, at: now });
    return allowed;
  }

  /** R-CHAT-05, 06, 16: one inbound frame. Identity is the attachment, never the frame. */
  async message(socket: RoomSocket, raw: string | ArrayBuffer): Promise<void> {
    const now = this.now();
    const sender = socket.attachment;
    if (sender.authUntil <= now) {
      closeSocket(socket, CLOSE_REAUTH, 'session expired');
      return;
    }
    if (typeof raw !== 'string') return this.error(socket, 'validation');
    if (new TextEncoder().encode(raw).byteLength > CHAT_FRAME_MAX_BYTES) {
      return this.error(socket, 'payload_too_large');
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.error(socket, 'validation');
    }
    const frame = clientFrameSchema.safeParse(json);
    if (!frame.success) return this.error(socket, 'validation', nonceOf(json));
    const { clientNonce, body } = frame.data;
    if (!this.take(sender.memberId, now)) return this.error(socket, 'rate_limited', clientNonce);

    // R-CHAT-16: the sender first, then up to the bound the read may carry.
    const before = this.deps.sockets();
    const ids = [
      ...new Set([sender.memberId, ...before.map((peer) => peer.attachment.memberId)]),
    ].slice(0, AUTHORIZE_MAX_MEMBERS);
    const bound = new Set(ids);
    let result;
    try {
      result = await sendMessage(
        this.deps.database,
        { id: uuidv7(now), senderId: sender.memberId, clientNonce, body, now },
        ids,
      );
    } catch {
      // INV-8: nothing is known saved, so nothing is acked or broadcast; a retry
      // with the same nonce returns the row if the write did land (R-CHAT-02).
      return this.error(socket, 'not_saved', clientNonce);
    }

    const message = result.row ? toChatMessage(EVERY_MEMBER, result.row) : null;
    // The conditional insert refused a sender who is no longer active (R-CHAT-09).
    if (!message) closeSocket(socket, CLOSE_FORBIDDEN, 'not authorized');
    else sendFrame(socket, { type: 'ack', clientNonce, message });

    // R-CHAT-16: an unusable authorization read saves and acks but broadcasts nothing;
    // clients catch up with `after=` (R-CHAT-11).
    const authorization = result.authorization;
    if (!authorization) return;
    const open =
      setupUnlockedIn(authorization.settings) &&
      effectiveSettings(authorization.settings).features.chat;
    const known = new Set(before);
    const reachedMemberIds = new Set<string>([sender.memberId]);
    for (const peer of this.live(this.deps.sockets())) {
      const { memberId } = peer.attachment;
      if (!open || (bound.has(memberId) && !authorization.activeIds.has(memberId))) {
        closeSocket(peer, CLOSE_FORBIDDEN, 'not authorized');
        continue;
      }
      // A socket opened while the batch ran was not in the read; its own context,
      // verified moments ago, is its authorization. One open before it whose member
      // did not fit the read's bound stays open but hears nothing this time.
      const authorized = bound.has(memberId) || !known.has(peer);
      if (authorized && message && result.inserted) {
        sendFrame(peer, { type: 'message', message });
        reachedMemberIds.add(memberId);
      }
    }

    // R-NTF-04, 07: after the broadcast, trigger chat push for members the broadcast did not reach.
    // A failed push never fails the ack; it is logged without any endpoint or key.
    if (
      open &&
      message &&
      !message.deleted &&
      result.inserted &&
      this.deps.push &&
      this.deps.vapid
    ) {
      const pushTask = sendChatPush(
        {
          database: this.deps.database,
          push: this.deps.push,
          vapid: this.deps.vapid,
          siteOrigin: sender.siteOrigin,
          now: this.now,
        },
        {
          senderId: sender.memberId,
          senderName: message.sender.displayName,
          messageText: message.body,
          connectedMemberIds: [...reachedMemberIds],
          now,
        },
      ).catch(() => logLine({ pushError: 'chat' }));
      if (this.deps.waitUntil) this.deps.waitUntil(pushTask);
      else await pushTask;
    }
  }
}
