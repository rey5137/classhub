import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// AC-CHAT-11 (review half) / R-CHAT-07: the room's code names no Durable Object storage,
// alarm or timer, so neither a new write nor a polling loop slips in unnoticed.

const ROOM_FILES = [
  'src/lib/server/adapters/cloudflare/chat-room.ts',
  'src/lib/server/services/chat-room.ts',
];

describe('ChatRoom source (R-CHAT-07, 08)', () => {
  it.each(ROOM_FILES)('AC-CHAT-11 %s names no storage, alarm or timer', (path) => {
    const code = readFileSync(path, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    expect(code).not.toMatch(/\.storage\b|setAlarm|setTimeout|setInterval|blockConcurrencyWhile/);
  });

  it('AC-CHAT-11 uses the Hibernation API to accept sockets', () => {
    const code = readFileSync(ROOM_FILES[0]!, 'utf8');
    expect(code).toContain('this.ctx.acceptWebSocket(');
    expect(code).toContain('serializeAttachment(');
    expect(code).not.toMatch(/\bserver\.accept\(\)/);
  });
});
