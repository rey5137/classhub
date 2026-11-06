import { describe, expect, it } from 'vitest';
import { CLOSE_FORBIDDEN, serverFrameSchema, type ServerFrame } from '../../src/lib/contracts/chat';
import type { Database } from '../../src/lib/server/ports/database';
import type { RealtimeHub, RealtimeMember } from '../../src/lib/server/ports/realtime';
import { PEOPLE } from '../fixtures/membership';

// R-PLAT-06 / AC-PLAT-03: one suite for both RealtimeHub adapters, the ChatRoom
// Durable Object and the local `ws` hub. Each harness seeds PEOPLE (seedMembership).

/** The client end of a socket, as a browser sees it. */
export interface ClientSocket {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeHarness {
  hub: RealtimeHub;
  database: Database;
  /** A socket opened through `hub.connect` for `member`. */
  open(member: RealtimeMember): Promise<ClientSocket>;
  dispose(): Promise<void>;
}

export type RealtimeFactory = () => Promise<RealtimeHarness>;

const WAIT_MS = 3_000;

export const MEMBERS = {
  active: {
    id: PEOPLE.active.id,
    role: 'member',
    displayName: 'Active Member',
    authUntil: Date.now() + 3_600_000,
  },
  admin: {
    id: PEOPLE.admin.id,
    role: 'admin',
    displayName: 'Class Admin',
    authUntil: Date.now() + 3_600_000,
  },
} satisfies Record<string, RealtimeMember>;

/** Frames in arrival order, a way to wait for the next of a type, and the close code. */
export class Probe {
  readonly frames: ServerFrame[] = [];
  /** Every frame type in arrival order, taken or not. */
  readonly seen: string[] = [];
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];

  constructor(readonly socket: ClientSocket) {
    socket.addEventListener('message', (event) => {
      const frame = serverFrameSchema.parse(JSON.parse(String(event.data)));
      this.frames.push(frame);
      this.seen.push(frame.type);
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
        for (const wake of this.waiters.splice(0)) wake();
      });
    });
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** The first frame of `type` not yet taken; frames before it stay for later calls. */
  async next<T extends ServerFrame['type']>(type: T): Promise<Extract<ServerFrame, { type: T }>> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const index = this.frames.findIndex((frame) => frame.type === type);
      if (index >= 0) return this.frames.splice(index, 1)[0] as Extract<ServerFrame, { type: T }>;
      if (Date.now() > deadline) throw new Error(`no ${type} frame within ${WAIT_MS} ms`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** Lets in-flight frames land, then lists the types still unread. */
  async pending(): Promise<string[]> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return this.frames.map((frame) => frame.type);
  }

  close(): void {
    try {
      this.socket.close(1000, 'done');
    } catch {
      // Already closed by the room.
    }
  }
}

export function sendFrame(body = 'hello class', clientNonce: string = crypto.randomUUID()) {
  return { type: 'send', clientNonce, body };
}

export function realtimeContract(name: string, create: RealtimeFactory): void {
  async function withHub(
    run: (
      harness: RealtimeHarness,
      open: (member: RealtimeMember) => Promise<Probe>,
    ) => Promise<void>,
  ) {
    const harness = await create();
    const probes: Probe[] = [];
    const open = async (member: RealtimeMember) => {
      const probe = new Probe(await harness.open(member));
      probes.push(probe);
      await probe.next('hello');
      return probe;
    };
    try {
      await run(harness, open);
    } finally {
      for (const probe of probes) probe.close();
      await harness.dispose();
    }
  }

  describe(`RealtimeHub contract: ${name}`, () => {
    it('AC-PLAT-03 says hello with the online count and the newest message id', async () => {
      await withHub(async (_harness, open) => {
        const first = await open(MEMBERS.active);
        first.send(sendFrame());
        const { message } = await first.next('ack');
        const second = new Probe(await _harness.open(MEMBERS.admin));
        const hello = await second.next('hello');
        expect(hello).toEqual({ type: 'hello', online: 2, lastId: message.id });
        expect(await first.next('online')).toEqual({ type: 'online', online: 2 });
        second.close();
        expect(await first.next('online')).toEqual({ type: 'online', online: 1 });
      });
    });

    it('AC-PLAT-03 a frame sent the moment the socket opens is answered after hello', async () => {
      await withHub(async (harness) => {
        const socket = await harness.open(MEMBERS.active);
        const probe = new Probe(socket);
        const frame = sendFrame('straight away');
        probe.send(frame);
        expect((await probe.next('ack')).clientNonce).toBe(frame.clientNonce);
        expect(probe.seen.slice(0, 2)).toEqual(['hello', 'ack']);
        probe.close();
      });
    });

    it('AC-PLAT-03 acks the sender and broadcasts to every socket after the row is stored', async () => {
      await withHub(async (harness, open) => {
        const sender = await open(MEMBERS.active);
        const other = await open(MEMBERS.admin);
        const frame = sendFrame('  xin chào 👋  ');
        sender.send(frame);
        const ack = await sender.next('ack');
        expect(ack.clientNonce).toBe(frame.clientNonce);
        expect(ack.message).toMatchObject({
          deleted: false,
          body: 'xin chào 👋',
          sender: { id: MEMBERS.active.id, displayName: 'Active Member' },
        });
        expect((await other.next('message')).message).toEqual(ack.message);
        expect((await sender.next('message')).message).toEqual(ack.message);
        const rows = await harness.database.db.query.chatMessages.findMany({
          where: (table, { eq }) => eq(table.id, ack.message.id),
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ roomId: 'main', clientNonce: frame.clientNonce });
      });
    });

    it('AC-PLAT-03 a resent nonce acks the original message and stores one row', async () => {
      await withHub(async (harness, open) => {
        const sender = await open(MEMBERS.active);
        const frame = sendFrame('only once');
        sender.send(frame);
        const first = await sender.next('ack');
        await sender.next('message');
        sender.send({ ...frame, body: 'a changed retry' });
        const second = await sender.next('ack');
        expect(second.message).toEqual(first.message);
        const rows = await harness.database.db.query.chatMessages.findMany({
          where: (table, { eq }) => eq(table.clientNonce, frame.clientNonce),
        });
        expect(rows).toHaveLength(1);
        // A retry is not a new message, so nobody hears it twice.
        expect(await sender.pending()).toEqual([]);
      });
    });

    it('AC-PLAT-03 disconnectMember closes that member’s sockets with 4003 only', async () => {
      await withHub(async (harness, open) => {
        const target = await open(MEMBERS.active);
        const secondTab = await open(MEMBERS.active);
        const other = await open(MEMBERS.admin);
        await harness.hub.disconnectMember(MEMBERS.active.id);
        expect(await target.closed).toBe(CLOSE_FORBIDDEN);
        expect(await secondTab.closed).toBe(CLOSE_FORBIDDEN);
        other.send(sendFrame('still here'));
        expect((await other.next('ack')).message).toMatchObject({ body: 'still here' });
      });
    });

    it('AC-PLAT-03 notify broadcasts a deletion frame naming only the id', async () => {
      await withHub(async (harness, open) => {
        const first = await open(MEMBERS.active);
        const second = await open(MEMBERS.admin);
        const id = crypto.randomUUID();
        await harness.hub.notify({ type: 'message.deleted', id });
        expect(await first.next('deleted')).toEqual({ type: 'deleted', id });
        expect(await second.next('deleted')).toEqual({ type: 'deleted', id });
      });
    });
  });
}
