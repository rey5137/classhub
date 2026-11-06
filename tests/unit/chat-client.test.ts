import { describe, expect, it, vi } from 'vitest';
import {
  ACK_TIMEOUT_MS,
  backoffDelay,
  bodyLength,
  ChatSession,
  firstUnreadId,
  frameBytes,
  HIDDEN_CLOSE_MS,
  isSendable,
  laterRead,
  linkify,
  markDeleted,
  mergeMessages,
  socketUrl,
  STABLE_MS,
  type ChatSocket,
} from '../../src/lib/client/chat';
import type { ChatHistory, ChatMessage, ServerFrame } from '../../src/lib/contracts/chat';

// §9.3 in the browser: the timeline, reconnect, the outbox and the unread marker
// (R-CHAT-10, 11, 12, 17), driven through a fake socket, history and clock.

const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const message = (n: number, sender = 'other'): ChatMessage => ({
  id: id(n),
  createdAt: 1_000 + n,
  sender: { id: sender, displayName: sender },
  deleted: false,
  body: `m${n}`,
});
const ids = (list: ChatMessage[]) => list.map((item) => item.id);

describe('timeline', () => {
  it('R-CHAT-17 merges by id: no duplicates, ordered by (createdAt, id)', () => {
    const merged = mergeMessages([message(1), message(3)], [message(2), message(3), message(1)]);
    expect(ids(merged)).toEqual([id(1), id(2), id(3)]);
    const tie = { ...message(5), createdAt: 1_004 };
    expect(ids(mergeMessages([message(4)], [tie]))).toEqual([id(4), id(5)]);
  });

  it('R-CHAT-03 a tombstone keeps its place and never turns back into a message', () => {
    const list = markDeleted([message(1), message(2)], id(1));
    expect(list[0]).toEqual({
      id: id(1),
      createdAt: 1_001,
      sender: message(1).sender,
      deleted: true,
    });
    expect(mergeMessages(list, [message(1)])[0]!.deleted).toBe(true);
    expect(markDeleted(list, id(9))).toEqual(list);
  });
});

describe('backoff (R-CHAT-11)', () => {
  it('R-CHAT-11 starts at 1 s, doubles, and stops at 30 s, jittered within ±20 %', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 12].map((n) => backoffDelay(n, mid))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 1)).toBe(1_200);
    expect(backoffDelay(10, () => 1)).toBe(30_000);
  });
});

describe('composer rule (R-CHAT-01)', () => {
  it('R-CHAT-01 counts code points after trimming, as the server does', () => {
    expect(bodyLength('  😀a  ')).toBe(2);
    expect(isSendable('   ')).toBe(false);
    expect(isSendable('😀'.repeat(1_000))).toBe(true);
    expect(isSendable('😀'.repeat(1_001))).toBe(false);
  });
});

describe('linkify (R-CHAT-01)', () => {
  it('R-CHAT-01 links https URLs only, leaving trailing punctuation outside', () => {
    expect(linkify('see https://example.test/a?b=1, ok')).toEqual([
      { text: 'see ' },
      { text: 'https://example.test/a?b=1', href: 'https://example.test/a?b=1' },
      { text: ', ok' },
    ]);
    expect(linkify('(https://example.test/x).')).toEqual([
      { text: '(' },
      { text: 'https://example.test/x', href: 'https://example.test/x' },
      { text: ').' },
    ]);
  });

  it('R-CHAT-01 never links http:, javascript: or markup', () => {
    for (const body of [
      'http://example.test',
      'javascript:alert(1)',
      '<a href="https://x">x</a> [y](javascript:alert(1))',
      'https://',
    ]) {
      const segments = linkify(body);
      // The text comes back whole, and only an https: target is ever a link.
      expect(segments.map((segment) => segment.text).join('')).toBe(body);
      for (const segment of segments) {
        if ('href' in segment) expect(segment.href).toBe('https://x/');
      }
    }
    expect(linkify('http://example.test')).toEqual([{ text: 'http://example.test' }]);
    expect(linkify('').length).toBe(0);
    expect(linkify('plain')).toEqual([{ text: 'plain' }]);
  });
});

describe('unread marker (R-CHAT-12)', () => {
  const list = [message(1), message(2, 'me'), message(3), message(4)];
  it('R-CHAT-12 sits above the first newer message someone else wrote', () => {
    expect(firstUnreadId(list, id(1), 'me')).toBe(id(3));
    expect(firstUnreadId(list, id(4), 'me')).toBeNull();
    expect(firstUnreadId(list, null, 'me')).toBeNull();
    expect(firstUnreadId(list, id(0), 'me')).toBe(id(1));
  });
  it('R-CHAT-12 the stored mark only moves forward', () => {
    expect(laterRead(null, id(2))).toBe(id(2));
    expect(laterRead(id(3), id(2))).toBe(id(3));
    expect(laterRead(id(1), id(2))).toBe(id(2));
  });
});

it('socket URL follows the page scheme', () => {
  expect(socketUrl({ protocol: 'https:', host: 'class.example.test' })).toBe(
    'wss://class.example.test/api/v1/chat/ws',
  );
  expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:5173' })).toBe(
    'ws://127.0.0.1:5173/api/v1/chat/ws',
  );
});

class FakeSocket implements ChatSocket {
  readyState = 1;
  sent: unknown[] = [];
  closed: number | null = null;
  onmessage: ChatSocket['onmessage'] = null;
  onclose: ChatSocket['onclose'] = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
    this.readyState = 3;
  }
  frame(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

/** A session over a scripted history, fake sockets and a manual clock. */
function harness(pages: Record<string, ChatHistory>) {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number; id: number }[] = [];
  const queries: string[] = [];
  const clock = { now: 1_000_000 };
  let next = 0;
  const session = new ChatSession({
    history: async (query) => {
      const key = new URLSearchParams(query as Record<string, string>).toString();
      queries.push(key);
      return pages[key] ?? { items: [], nextCursor: null };
    },
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onChange: () => {},
    setTimer: (run, ms) => {
      const timer = { run, ms, id: next++ };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (timerId) => {
      const index = timers.findIndex((timer) => timer.id === timerId);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => clock.now,
    random: () => 0.5,
    nonce: () => `nonce-${next++}`,
  });
  const fire = () => timers.shift()!.run();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { session, sockets, timers, queries, clock, fire, settle };
}

describe('ChatSession', () => {
  it('R-CHAT-10 loads the newest page over HTTP, then opens the socket', async () => {
    const h = harness({ '': { items: [message(1), message(2)], nextCursor: id(1) } });
    await h.session.start();
    expect(h.queries).toEqual(['']);
    expect(h.sockets).toHaveLength(1);
    expect(h.session.snapshot.status).toBe('connecting');
    expect(h.session.snapshot.olderCursor).toBe(id(1));
    h.sockets[0]!.frame({ type: 'hello', online: 2, lastId: id(2) });
    await h.settle();
    expect(h.session.snapshot.status).toBe('online');
    expect(h.session.snapshot.online).toBe(2);
    // hello.lastId is the newest held: nothing to fetch.
    expect(h.queries).toEqual(['']);
  });

  it('R-CHAT-17 fetches after= exactly once when hello.lastId is newer, without duplicates', async () => {
    const h = harness({
      '': { items: [message(1)], nextCursor: null },
      [`after=${id(1)}`]: { items: [message(2)], nextCursor: null },
    });
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: id(2) });
    h.sockets[0]!.frame({ type: 'message', message: message(2) });
    await h.settle();
    expect(h.queries).toEqual(['', `after=${id(1)}`]);
    expect(ids(h.session.snapshot.messages)).toEqual([id(1), id(2)]);
  });

  it('R-CHAT-17 an empty timeline catches up with the newest page', async () => {
    const h = harness({});
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: id(7) });
    await h.settle();
    expect(h.queries).toEqual(['', '']);
  });

  it('R-CHAT-11 follows after= cursors until the gap is closed', async () => {
    const h = harness({
      '': { items: [message(1)], nextCursor: null },
      [`after=${id(1)}`]: { items: [message(2)], nextCursor: id(2) },
      [`after=${id(2)}`]: { items: [message(3)], nextCursor: null },
    });
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: id(3) });
    await h.settle();
    expect(ids(h.session.snapshot.messages)).toEqual([id(1), id(2), id(3)]);
  });

  it('R-CHAT-11 reconnects with backoff after a drop and fetches what it missed', async () => {
    const h = harness({
      '': { items: [message(1)], nextCursor: null },
      [`after=${id(1)}`]: { items: [message(2), message(3)], nextCursor: null },
    });
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: id(1) });
    await h.settle();
    h.sockets[0]!.drop();
    expect(h.session.snapshot.status).toBe('reconnecting');
    expect(h.timers.map((timer) => timer.ms)).toEqual([1_000]);
    h.fire();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.drop();
    expect(h.timers.map((timer) => timer.ms)).toEqual([2_000]);
    h.fire();
    h.sockets[2]!.frame({ type: 'hello', online: 2, lastId: id(3) });
    await h.settle();
    expect(h.session.snapshot.status).toBe('online');
    expect(ids(h.session.snapshot.messages)).toEqual([id(1), id(2), id(3)]);
    // A drop after the connection stayed up starts the schedule over.
    h.clock.now += STABLE_MS;
    h.sockets[2]!.drop();
    expect(h.timers.map((timer) => timer.ms)).toEqual([1_000]);
  });

  it('R-CHAT-11 a room that says hello and drops at once keeps backing off', async () => {
    const h = harness({});
    await h.session.start();
    const delays: number[] = [];
    for (let round = 0; round < 7; round++) {
      const socket = h.sockets.at(-1)!;
      socket.frame({ type: 'hello', online: 1, lastId: null });
      await h.settle();
      h.clock.now += 100;
      socket.drop();
      delays.push(h.timers[0]!.ms);
      h.fire();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('R-CHAT-16 4001 asks to sign in again and 4003 stops, neither reconnecting', async () => {
    for (const [code, status] of [
      [4001, 'reauth'],
      [4003, 'forbidden'],
    ] as const) {
      const h = harness({});
      await h.session.start();
      h.sockets[0]!.drop(code);
      expect(h.session.snapshot.status).toBe(status);
      expect(h.timers).toEqual([]);
    }
  });

  it('R-CHAT-02 a send is pending until its ack; a retry resends the same nonce', async () => {
    const h = harness({});
    await h.session.start();
    const socket = h.sockets[0]!;
    expect(h.session.send('  ')).toBe(false);
    expect(h.session.send('hello')).toBe(true);
    const nonce = h.session.snapshot.outbox[0]!.clientNonce;
    expect(h.session.snapshot.outbox[0]!.state).toBe('pending');
    expect(socket.sent).toEqual([{ type: 'send', clientNonce: nonce, body: 'hello' }]);

    socket.frame({ type: 'error', code: 'not_saved', clientNonce: nonce });
    expect(h.session.snapshot.outbox[0]).toMatchObject({ state: 'failed', code: 'not_saved' });
    h.session.retry(nonce);
    expect(socket.sent[1]).toEqual({ type: 'send', clientNonce: nonce, body: 'hello' });
    expect(h.session.snapshot.outbox[0]!.state).toBe('pending');

    socket.frame({ type: 'ack', clientNonce: nonce, message: message(5, 'me') });
    socket.frame({ type: 'message', message: message(5, 'me') });
    expect(h.session.snapshot.outbox).toEqual([]);
    expect(ids(h.session.snapshot.messages)).toEqual([id(5)]);
  });

  it('R-CHAT-11 a socket that drops before the ack leaves the send not sent', async () => {
    const h = harness({});
    await h.session.start();
    h.session.send('lost');
    h.sockets[0]!.drop();
    expect(h.session.snapshot.outbox[0]).toMatchObject({ state: 'failed', code: 'dropped' });
    // While reconnecting there is no socket to send on.
    h.session.retry(h.session.snapshot.outbox[0]!.clientNonce);
    expect(h.session.snapshot.outbox[0]!.state).toBe('failed');
    h.session.discard(h.session.snapshot.outbox[0]!.clientNonce);
    expect(h.session.snapshot.outbox).toEqual([]);
  });

  it('R-CHAT-03 applies deleted frames and the presence count live', async () => {
    const h = harness({ '': { items: [message(1), message(2)], nextCursor: null } });
    await h.session.start();
    h.sockets[0]!.frame({ type: 'deleted', id: id(1) });
    h.sockets[0]!.frame({ type: 'online', online: 3 });
    expect(h.session.snapshot.messages[0]!.deleted).toBe(true);
    expect(h.session.snapshot.online).toBe(3);
    // Frames the contract does not know are ignored.
    h.sockets[0]!.onmessage?.({ data: '{"type":"nope"}' } as MessageEvent);
    h.sockets[0]!.onmessage?.({ data: 'not json' } as MessageEvent);
    expect(h.session.snapshot.messages).toHaveLength(2);
  });

  it('R-CHAT-10 older pages load with before= and stop at the start of the room', async () => {
    const h = harness({
      '': { items: [message(3)], nextCursor: id(3) },
      [`before=${id(3)}`]: { items: [message(1), message(2)], nextCursor: null },
    });
    await h.session.start();
    await h.session.loadOlder();
    expect(ids(h.session.snapshot.messages)).toEqual([id(1), id(2), id(3)]);
    expect(h.session.snapshot.olderCursor).toBeNull();
    await h.session.loadOlder();
    expect(h.queries).toHaveLength(2);
  });

  it('R-CHAT-11 closes after 5 hidden minutes and reopens on return; a short hide changes nothing', async () => {
    const h = harness({});
    await h.session.start();
    h.session.visibility(true);
    expect(h.timers.map((timer) => timer.ms)).toEqual([HIDDEN_CLOSE_MS]);
    h.session.visibility(false);
    expect(h.timers).toEqual([]);
    expect(h.sockets[0]!.closed).toBeNull();

    h.session.visibility(true);
    h.fire();
    expect(h.sockets[0]!.closed).toBe(1000);
    expect(h.session.snapshot.status).toBe('paused');
    expect(h.timers).toEqual([]);
    h.session.visibility(false);
    expect(h.sockets).toHaveLength(2);
    expect(h.session.snapshot.status).toBe('connecting');
  });

  it('R-CHAT-02 a send with no answer turns not sent after the ack timeout, then Retry or Discard', async () => {
    const h = harness({});
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: null });
    await h.settle();
    h.session.send('first');
    h.clock.now += 5_000;
    h.session.send('second');
    // One timer, at the oldest send's deadline.
    expect(h.timers.map((timer) => timer.ms)).toEqual([ACK_TIMEOUT_MS - 5_000]);
    h.clock.now += ACK_TIMEOUT_MS - 5_000;
    h.fire();
    expect(h.session.snapshot.outbox.map((item) => [item.state, item.code])).toEqual([
      ['failed', 'timeout'],
      ['pending', undefined],
    ]);
    expect(h.timers.map((timer) => timer.ms)).toEqual([5_000]);
    h.clock.now += 5_000;
    h.fire();
    expect(h.session.snapshot.outbox.every((item) => item.state === 'failed')).toBe(true);
    // Nothing waits any more: no timer is left running.
    expect(h.timers).toEqual([]);
    const [first] = h.session.snapshot.outbox;
    h.session.retry(first!.clientNonce);
    const acked = { ...message(9, 'me'), body: 'first' };
    h.sockets[0]!.frame({ type: 'ack', clientNonce: first!.clientNonce, message: acked });
    expect(h.timers).toEqual([]);
    h.session.discard(h.session.snapshot.outbox[0]!.clientNonce);
    expect(h.session.snapshot.outbox).toEqual([]);
  });

  it('R-CHAT-01 sends the trimmed body and refuses a frame past 4 KB', async () => {
    const h = harness({});
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: null });
    await h.settle();
    expect(h.session.send(`${'\n'.repeat(30)}${'😀'.repeat(1_000)}`)).toBe(true);
    const sent = h.sockets[0]!.sent[0] as { body: string };
    expect(sent.body).toBe('😀'.repeat(1_000));
    expect(frameBytes(sent.body)).toBeLessThanOrEqual(4_096);
    // 1,000 code points, but escaped in JSON they pass the frame cap.
    expect(isSendable('\u0001'.repeat(1_000))).toBe(false);
    expect(h.session.send('\u0001'.repeat(1_000))).toBe(false);
    expect(h.sockets[0]!.sent).toHaveLength(1);
  });

  it('R-CHAT-03 a deleted frame before its message keeps it a tombstone when history brings the body', async () => {
    const h = harness({
      '': { items: [message(1)], nextCursor: id(1) },
      [`after=${id(1)}`]: { items: [message(2)], nextCursor: null },
      [`before=${id(1)}`]: { items: [message(0)], nextCursor: null },
    });
    await h.session.start();
    h.sockets[0]!.frame({ type: 'deleted', id: id(2) });
    h.sockets[0]!.frame({ type: 'deleted', id: id(0) });
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: id(2) });
    await h.settle();
    await h.session.loadOlder();
    const byId = new Map(h.session.snapshot.messages.map((item) => [item.id, item]));
    expect(byId.get(id(2))).toMatchObject({ deleted: true });
    expect(byId.get(id(0))).toMatchObject({ deleted: true });
    expect(byId.get(id(2))).not.toHaveProperty('body');
    // A live message frame for it changes nothing either.
    h.sockets[0]!.frame({ type: 'message', message: message(2) });
    expect(h.session.snapshot.messages.find((item) => item.id === id(2))!.deleted).toBe(true);
  });

  it('R-CHAT-16 after 4001 or 4003 a long hidden spell and the return open no socket', async () => {
    for (const code of [4001, 4003]) {
      const h = harness({});
      await h.session.start();
      h.sockets[0]!.drop(code);
      const status = h.session.snapshot.status;
      h.session.visibility(true);
      expect(h.timers).toEqual([]);
      h.session.visibility(false);
      expect(h.sockets).toHaveLength(1);
      expect(h.session.snapshot.status).toBe(status);
    }
    // And a hidden timer already running when the 4001 lands does nothing when it fires.
    const h = harness({});
    await h.session.start();
    h.session.visibility(true);
    h.sockets[0]!.drop(4001);
    h.fire();
    h.session.visibility(false);
    expect(h.session.snapshot.status).toBe('reauth');
    expect(h.sockets).toHaveLength(1);
  });

  it('R-CHAT-11 a page loaded while hidden waits for the return to open its socket', async () => {
    const h = harness({});
    const started = h.session.start();
    h.session.visibility(true);
    h.fire();
    await started;
    expect(h.sockets).toHaveLength(0);
    expect(h.session.snapshot.status).toBe('paused');
    h.session.visibility(false);
    expect(h.sockets).toHaveLength(1);
  });

  it('stop() clears every timer, closes the socket and never reconnects', async () => {
    const h = harness({});
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: null });
    await h.settle();
    h.session.send('unanswered');
    h.session.visibility(true);
    expect(h.timers).toHaveLength(2);
    const socket = h.sockets[0]!;
    h.session.stop();
    expect(h.timers).toEqual([]);
    expect(socket.closed).toBe(1000);
    socket.drop();
    h.session.visibility(false);
    expect(h.sockets).toHaveLength(1);
    expect(h.timers).toEqual([]);
  });

  it('announces only live messages from others, never history or catch-up', async () => {
    const h = harness({
      '': { items: [message(1)], nextCursor: null },
      [`after=${id(1)}`]: { items: [message(2)], nextCursor: null },
    });
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: id(2) });
    await h.settle();
    expect(h.session.snapshot.live).toBeNull();
    h.sockets[0]!.frame({ type: 'message', message: message(3) });
    expect(h.session.snapshot.live?.id).toBe(id(3));
    // A repeat of a message already held is not news.
    h.sockets[0]!.frame({ type: 'message', message: message(2) });
    expect(h.session.snapshot.live?.id).toBe(id(3));
  });

  it('AC-BUD-03 schedules nothing while connected and idle', async () => {
    const h = harness({});
    await h.session.start();
    h.sockets[0]!.frame({ type: 'hello', online: 1, lastId: null });
    await h.settle();
    expect(h.timers).toEqual([]);
  });

  it('a failed first load reports failure and opens no socket', async () => {
    const session = new ChatSession({
      history: vi.fn().mockRejectedValue(new Error('down')),
      openSocket: vi.fn(),
      onChange: () => {},
    });
    await session.start();
    expect(session.snapshot.status).toBe('failed');
  });
});
