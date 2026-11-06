import {
  chatBodySchema,
  chatHistorySchema,
  CHAT_FRAME_MAX_BYTES,
  CHAT_WS_PATH,
  CLOSE_FORBIDDEN,
  CLOSE_REAUTH,
  serverFrameSchema,
  type ChatErrorCode,
  type ChatHistory,
  type ChatMessage,
  type ServerFrame,
} from '../contracts/chat';

// §9.3 from the browser: the timeline, the socket's life (R-CHAT-10, 11, 17), the
// outbox (R-CHAT-02) and the unread marker (R-CHAT-12). Plain TS so it is unit-tested;
// the /chat page only renders a snapshot and forwards events.

/** R-CHAT-12: the only thing kept about reading, and only in this browser. */
export const LAST_READ_KEY = 'classhub.chat.lastRead';
/** R-CHAT-11: the socket closes after the tab has been hidden this long. */
export const HIDDEN_CLOSE_MS = 5 * 60_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A connection up this long counts as recovered: the next drop starts the backoff at 1 s. */
export const STABLE_MS = 30_000;
/** A send with no ack (or error) by then shows *not sent* with Retry (R-CHAT-02). */
export const ACK_TIMEOUT_MS = 15_000;
/** A catch-up stops here rather than loop on a cursor that does not advance. */
const CATCH_UP_PAGES = 40;
const HISTORY_TIMEOUT_MS = 15_000;

/** R-CHAT-11: 1 s doubling to 30 s, each delay jittered by ±20 % and never past the cap. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt));
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (0.8 + 0.4 * random())));
}

const before = (a: ChatMessage, b: ChatMessage) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const tombstone = (message: ChatMessage): ChatMessage => ({
  id: message.id,
  createdAt: message.createdAt,
  sender: message.sender,
  deleted: true,
});

/**
 * The timeline after `incoming` arrives: one entry per id, ordered by (createdAt, id) as
 * the server pages them. A tombstone never turns back into a message, and an id in
 * `deleted` (its `deleted` frame may beat a history page that still had the body) comes
 * in as a tombstone.
 */
export function mergeMessages(
  list: ChatMessage[],
  incoming: ChatMessage[],
  deleted: ReadonlySet<string> = new Set(),
): ChatMessage[] {
  const byId = new Map(list.map((message) => [message.id, message]));
  for (const message of incoming) {
    const held = byId.get(message.id);
    if (held?.deleted) continue;
    byId.set(
      message.id,
      deleted.has(message.id) && !message.deleted ? tombstone(message) : message,
    );
  }
  return [...byId.values()].sort(before);
}

/** R-CHAT-03: the message keeps its place as a tombstone, its body gone. */
export function markDeleted(list: ChatMessage[], id: string): ChatMessage[] {
  return list.map((message) =>
    message.id === id && !message.deleted ? tombstone(message) : message,
  );
}

/** The composer's rule is the server's (R-CHAT-01): 1-1,000 code points after trimming. */
export function bodyLength(body: string): number {
  return Array.from(body.trim()).length;
}

/** The UTF-8 size of the frame that carries `body` (a nonce is always 36 characters). */
export function frameBytes(body: string): number {
  const frame = { type: 'send', clientNonce: '00000000-0000-0000-0000-000000000000', body };
  return new TextEncoder().encode(JSON.stringify(frame)).length;
}

/** What the room accepts: R-CHAT-01's length, and a frame within R-AUTH-22's 4 KB. */
export function isSendable(body: string): boolean {
  return chatBodySchema.safeParse(body).success && frameBytes(body.trim()) <= CHAT_FRAME_MAX_BYTES;
}

export type Segment = { text: string } | { text: string; href: string };

const URL_PATTERN = /https:\/\/[^\s<>"']+/gi;
/** Punctuation that usually ends the sentence around a link rather than the link itself. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * R-CHAT-01: plain text with `https:` URLs turned into links, on display only. Anything
 * else (`http:`, `javascript:`, markup) stays text; the page renders segments as text nodes.
 */
export function linkify(body: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of body.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING, '');
    let href: string | null = null;
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' && url.hostname) href = url.href;
    } catch {
      href = null;
    }
    if (!href) continue;
    const start = match.index;
    if (start > last) segments.push({ text: body.slice(last, start) });
    segments.push({ text: raw, href });
    last = start + raw.length;
  }
  if (last < body.length) segments.push({ text: body.slice(last) });
  return segments;
}

/**
 * R-CHAT-12: the first message after `lastRead` that someone else wrote, above which the
 * marker sits; null when nothing is unread or this browser has never read the room.
 * Ids are UUIDv7, so they compare in time order.
 */
export function firstUnreadId(
  list: ChatMessage[],
  lastRead: string | null,
  viewerId: string,
): string | null {
  if (!lastRead) return null;
  return (
    list.find((message) => message.id > lastRead && message.sender.id !== viewerId)?.id ?? null
  );
}

/** The newer of two last-read ids (a stale tab never moves the mark back). */
export function laterRead(stored: string | null, seen: string): string {
  return stored && stored >= seen ? stored : seen;
}

export type Outgoing = {
  clientNonce: string;
  /** Trimmed, exactly as validated and as sent. */
  body: string;
  state: 'pending' | 'failed';
  code?: ChatErrorCode | 'dropped' | 'timeout';
  /** When the last attempt went out, for the ack timeout. */
  sentAt?: number;
};

/** `forbidden`: 4003; `reauth`: 4001; `paused`: closed while the tab was hidden. */
export type ChatStatus =
  | 'loading'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'reauth'
  | 'forbidden'
  | 'paused'
  | 'failed';

/** States only a reload (or Try again) leaves: no timer or tab switch reopens a socket. */
const TERMINAL: ReadonlySet<ChatStatus> = new Set(['reauth', 'forbidden', 'failed']);

export interface ChatSnapshot {
  messages: ChatMessage[];
  outbox: Outgoing[];
  status: ChatStatus;
  online: number | null;
  /** The `before=` cursor for older messages, or null at the start of the room. */
  olderCursor: string | null;
  loadingOlder: boolean;
  /**
   * The newest message that arrived live from someone else (a `message` frame), for the
   * page's announcer; history pages and catch-ups never set it, so they are never read out.
   */
  live: ChatMessage | null;
}

/** What the session needs of a WebSocket (the browser's, or a fake in tests). */
export interface ChatSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export interface ChatDeps {
  history(query: { before?: string; after?: string }): Promise<ChatHistory>;
  openSocket(): ChatSocket;
  onChange(snapshot: ChatSnapshot): void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
  random?: () => number;
  nonce?: () => string;
}

const OPEN = 1;

export class ChatSession {
  private state: ChatSnapshot = {
    messages: [],
    outbox: [],
    status: 'loading',
    online: null,
    olderCursor: null,
    loadingOlder: false,
    live: null,
  };
  private socket: ChatSocket | null = null;
  private attempt = 0;
  /** When the current socket said hello, or null before it has. */
  private helloAt: number | null = null;
  private reconnectTimer: unknown = null;
  private hiddenTimer: unknown = null;
  private ackTimer: unknown = null;
  private stopped = false;
  /** R-CHAT-03: ids seen deleted, so a history page that still had the body can't revive one. */
  private readonly deletedIds = new Set<string>();
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly deps: ChatDeps) {
    this.setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as number));
    this.now = deps.now ?? Date.now;
  }

  get snapshot(): ChatSnapshot {
    return this.state;
  }

  private update(patch: Partial<ChatSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private merge(incoming: ChatMessage[]): ChatMessage[] {
    return mergeMessages(this.state.messages, incoming, this.deletedIds);
  }

  /** R-CHAT-10: the newest page over HTTP first, then the socket. */
  async start(): Promise<void> {
    this.update({ status: 'loading' });
    try {
      const page = await this.deps.history({});
      if (this.stopped) return;
      this.update({ messages: this.merge(page.items), olderCursor: page.nextCursor });
    } catch {
      if (!this.stopped) this.update({ status: 'failed' });
      return;
    }
    // Hidden for 5 minutes while the page loaded: the return opens the socket.
    if (this.state.status === 'paused') return;
    this.connect();
  }

  async loadOlder(): Promise<void> {
    const cursor = this.state.olderCursor;
    if (!cursor || this.state.loadingOlder) return;
    this.update({ loadingOlder: true });
    try {
      const page = await this.deps.history({ before: cursor });
      this.update({
        messages: this.merge(page.items),
        olderCursor: page.nextCursor,
        loadingOlder: false,
      });
    } catch {
      this.update({ loadingOlder: false });
    }
  }

  /** @returns false when the body breaks R-CHAT-01 or the frame cap and nothing was queued */
  send(body: string): boolean {
    if (!isSendable(body)) return false;
    const clientNonce = this.deps.nonce?.() ?? crypto.randomUUID();
    this.update({
      outbox: [...this.state.outbox, { clientNonce, body: body.trim(), state: 'pending' }],
    });
    this.transmit(clientNonce);
    return true;
  }

  /** R-CHAT-02: a retry resends the same nonce, so the room answers with the original row. */
  retry(clientNonce: string): void {
    this.setOutgoing(clientNonce, { state: 'pending', code: undefined });
    this.transmit(clientNonce);
  }

  discard(clientNonce: string): void {
    this.update({ outbox: this.state.outbox.filter((item) => item.clientNonce !== clientNonce) });
    this.armAckTimer();
  }

  /** The DELETE went through, or the room's `deleted` frame came; either may come twice. */
  deleted(id: string): void {
    this.deletedIds.add(id);
    this.update({ messages: markDeleted(this.state.messages, id) });
  }

  /** R-CHAT-11: hidden for over 5 minutes closes the socket; coming back reopens it. */
  visibility(hidden: boolean): void {
    if (this.stopped || TERMINAL.has(this.state.status)) return;
    if (hidden) {
      if (this.hiddenTimer === null) {
        this.hiddenTimer = this.setTimer(() => {
          this.hiddenTimer = null;
          this.pause();
        }, HIDDEN_CLOSE_MS);
      }
      return;
    }
    if (this.hiddenTimer !== null) this.clearTimer(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.state.status === 'paused') {
      this.attempt = 0;
      this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.reconnectTimer, this.hiddenTimer, this.ackTimer]) {
      if (timer !== null) this.clearTimer(timer);
    }
    this.reconnectTimer = this.hiddenTimer = this.ackTimer = null;
    this.drop();
  }

  private pause(): void {
    // A 4001/4003 or a failed load ended things already; hiding must not turn them back on.
    if (TERMINAL.has(this.state.status)) return;
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.drop();
    this.update({ status: 'paused', online: null });
    this.failPending();
  }

  /** Closes the socket without its close handler scheduling a reconnect. */
  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.helloAt = null;
    if (!socket) return;
    socket.onmessage = socket.onclose = null;
    socket.close(1000);
  }

  private connect(): void {
    if (this.stopped) return;
    this.reconnectTimer = null;
    this.update({ status: this.attempt === 0 ? 'connecting' : 'reconnecting' });
    let socket: ChatSocket;
    try {
      socket = this.deps.openSocket();
    } catch {
      return this.scheduleReconnect();
    }
    this.socket = socket;
    this.helloAt = null;
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const frame = serverFrameSchema.safeParse(json);
      if (frame.success) void this.receive(frame.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      // R-CHAT-11: only a connection that stayed up starts the backoff over, so a room
      // that accepts and drops at once is retried ever more slowly, not every second.
      if (this.helloAt !== null && this.now() - this.helloAt >= STABLE_MS) this.attempt = 0;
      this.socket = null;
      this.helloAt = null;
      this.failPending();
      if (event.code === CLOSE_REAUTH) return this.update({ status: 'reauth', online: null });
      if (event.code === CLOSE_FORBIDDEN) return this.update({ status: 'forbidden', online: null });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, this.deps.random);
    this.attempt += 1;
    this.update({ status: 'reconnecting', online: null });
    this.reconnectTimer = this.setTimer(() => this.connect(), delay);
  }

  private async receive(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case 'hello': {
        this.helloAt = this.now();
        this.update({ status: 'online', online: frame.online });
        const newest = this.state.messages.at(-1)?.id ?? null;
        // R-CHAT-17 at startup and R-CHAT-11 after a reconnect: only a gap is fetched.
        if (frame.lastId !== null && frame.lastId !== newest) await this.catchUp(newest);
        return;
      }
      case 'online':
        return this.update({ online: frame.online });
      case 'ack':
        this.update({
          messages: this.merge([frame.message]),
          outbox: this.state.outbox.filter((item) => item.clientNonce !== frame.clientNonce),
        });
        return this.armAckTimer();
      case 'message': {
        const known = this.state.messages.some((message) => message.id === frame.message.id);
        return this.update({
          messages: this.merge([frame.message]),
          live: known ? this.state.live : frame.message,
        });
      }
      case 'deleted':
        return this.deleted(frame.id);
      case 'error':
        // A frame the room could not read (oversized) carries no nonce: the ack timeout
        // turns its send into *not sent*.
        if (frame.clientNonce) {
          this.setOutgoing(frame.clientNonce, { state: 'failed', code: frame.code });
          this.armAckTimer();
        }
    }
  }

  /** Every page after `after` (the newest page when the timeline is empty), merged by id. */
  private async catchUp(after: string | null): Promise<void> {
    let cursor = after;
    for (let page = 0; page < CATCH_UP_PAGES; page++) {
      let history: ChatHistory;
      try {
        history = await this.deps.history(cursor ? { after: cursor } : {});
      } catch {
        return;
      }
      this.update({ messages: this.merge(history.items) });
      // With no cursor the newest page came back; anything older pages in by `before=`.
      if (!cursor || !history.nextCursor || history.nextCursor === cursor) return;
      cursor = history.nextCursor;
    }
  }

  private transmit(clientNonce: string): void {
    const item = this.state.outbox.find((entry) => entry.clientNonce === clientNonce);
    if (!item) return;
    if (!this.socket || this.socket.readyState !== OPEN) {
      this.setOutgoing(clientNonce, { state: 'failed', code: 'dropped' });
      return;
    }
    this.setOutgoing(clientNonce, { sentAt: this.now() });
    this.socket.send(JSON.stringify({ type: 'send', clientNonce, body: item.body }));
    this.armAckTimer();
  }

  /**
   * One timer, and only while a send waits for its ack (AC-BUD-03): it fires at the
   * oldest send's deadline, fails what is overdue and re-arms for the rest.
   */
  private armAckTimer(): void {
    if (this.ackTimer !== null) this.clearTimer(this.ackTimer);
    this.ackTimer = null;
    const waiting = this.state.outbox.filter((item) => item.state === 'pending' && item.sentAt);
    if (this.stopped || waiting.length === 0) return;
    const oldest = Math.min(...waiting.map((item) => item.sentAt!));
    this.ackTimer = this.setTimer(
      () => {
        this.ackTimer = null;
        const deadline = this.now() - ACK_TIMEOUT_MS;
        this.update({
          outbox: this.state.outbox.map((item) =>
            item.state === 'pending' && item.sentAt !== undefined && item.sentAt <= deadline
              ? { ...item, state: 'failed', code: 'timeout' }
              : item,
          ),
        });
        this.armAckTimer();
      },
      Math.max(0, oldest + ACK_TIMEOUT_MS - this.now()),
    );
  }

  /** A socket that closed before the ack leaves its sends *not sent*, for the member to retry. */
  private failPending(): void {
    if (this.state.outbox.some((item) => item.state === 'pending')) {
      this.update({
        outbox: this.state.outbox.map((item) =>
          item.state === 'pending' ? { ...item, state: 'failed', code: 'dropped' } : item,
        ),
      });
    }
    this.armAckTimer();
  }

  private setOutgoing(clientNonce: string, patch: Partial<Outgoing>): void {
    this.update({
      outbox: this.state.outbox.map((item) =>
        item.clientNonce === clientNonce ? { ...item, ...patch } : item,
      ),
    });
  }
}

/** The page's history call: `GET /api/v1/chat/messages`, parsed at the boundary. */
export async function fetchHistory(query: {
  before?: string;
  after?: string;
}): Promise<ChatHistory> {
  const params = new URLSearchParams(query as Record<string, string>);
  const response = await fetch(`/api/v1/chat/messages${params.size ? `?${params}` : ''}`, {
    signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`history ${response.status}`);
  return chatHistorySchema.parse(await response.json());
}

export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${CHAT_WS_PATH}`;
}
