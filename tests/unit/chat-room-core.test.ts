import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSE_FORBIDDEN } from '../../src/lib/contracts/chat';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { users } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import { AUTHORIZE_MAX_MEMBERS } from '../../src/lib/server/repositories/chat';
import { ChatRoomCore, type RoomSocket } from '../../src/lib/server/services/chat-room';
import { normalizeName } from '../../src/lib/shared/normalize';
import { setSetupState } from '../fixtures/membership';

// R-CHAT-16: the authorization read binds at most 50 member ids. The room asks about
// exactly the ids it sends, so a member beyond the bound is neither closed as
// unauthorized nor sent a message the read did not authorize.

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
const NOW = 1_800_000_000_000;
const ids = Array.from({ length: AUTHORIZE_MAX_MEMBERS + 2 }, () => uuidv7());

interface FakeSocket extends RoomSocket {
  frames: string[];
  closedWith?: number;
}

function socketFor(memberId: string): FakeSocket {
  const socket: FakeSocket = {
    attachment: {
      memberId,
      role: 'member',
      displayName: 'Classmate',
      connectedAt: NOW,
      authUntil: NOW + 3_600_000,
    },
    frames: [],
    send: (text) => void socket.frames.push(JSON.parse(text).type),
    close: (code) => {
      socket.closedWith = code;
    },
  };
  return socket;
}

beforeAll(async () => {
  await setSetupState(database, 'unlocked');
  for (const [index, id] of ids.entries()) {
    const name = `Classmate ${index}`;
    await database.db.insert(users).values({
      id,
      authEmail: `${id}@example.test`,
      displayName: name,
      displayNameNorm: normalizeName(name),
      role: 'member',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
});

afterAll(() => database.close());

describe('ChatRoom authorization bound (R-CHAT-16)', () => {
  it('R-CHAT-16 with 52 members online the 50 read are judged, the 2 beyond stay open unsent', async () => {
    // A member inside the bound is suspended, so the read is seen to judge it.
    await database.db.update(users).set({ status: 'suspended' }).where(eq(users.id, ids[1]!));
    const sockets = ids.map(socketFor);
    const room = new ChatRoomCore({ database, sockets: () => sockets, now: () => NOW });
    await room.message(
      sockets[0]!,
      JSON.stringify({ type: 'send', clientNonce: crypto.randomUUID(), body: 'roll call' }),
    );

    expect(sockets[0]!.frames).toEqual(['ack', 'message']);
    expect(sockets[1]!.closedWith).toBe(CLOSE_FORBIDDEN);
    const inside = sockets.slice(2, AUTHORIZE_MAX_MEMBERS);
    expect(inside.every((socket) => socket.frames.join() === 'message' && !socket.closedWith)).toBe(
      true,
    );
    for (const socket of sockets.slice(AUTHORIZE_MAX_MEMBERS)) {
      expect({ frames: socket.frames, closed: socket.closedWith }).toEqual({
        frames: [],
        closed: undefined,
      });
    }
  });
});
