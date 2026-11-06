import { describe, expect, it } from 'vitest';
import { chatBodySchema, chatMessageSchema, clientFrameSchema } from '../../src/lib/contracts/chat';
import { DEFAULT_VISIBILITY } from '../../src/lib/contracts/profile';
import type { ChatRow } from '../../src/lib/server/repositories/chat';
import { EVERY_MEMBER, toChatMessage } from '../../src/lib/server/services/chat';

// R-CHAT-01, R-CHAT-03, R-PROF-04: the message DTO and the frame schema.

function row(avatar: 'members' | 'admins' | 'private', deletedAt: number | null = null): ChatRow {
  return {
    id: '01900000-0000-7000-8000-0000000000aa',
    authorId: 'sender-1',
    body: deletedAt === null ? 'chào cả lớp' : '',
    createdAt: 1_800_000_000_000,
    deletedAt,
    author: {
      id: 'sender-1',
      displayName: 'Lan',
      status: 'active',
      preferredName: 'Lan Anh',
      avatarMediaId: 'avatar-1',
      deletionRequestedAt: null,
      contacts: {
        contactEmail: 'lan@example.test',
        phone: '+84 900 000 000',
        messagingUrl: null,
        city: 'Huế',
        bio: 'hi',
        visibilityJson: JSON.stringify({ ...DEFAULT_VISIBILITY, avatar_media_id: avatar }),
      },
    },
  };
}

describe('chat message DTO (R-PROF-04)', () => {
  it('R-PROF-04 a broadcast carries the avatar only when every member may see it', () => {
    expect(toChatMessage(EVERY_MEMBER, row('members')).sender).toEqual({
      id: 'sender-1',
      displayName: 'Lan',
      avatarMediaId: 'avatar-1',
    });
    expect(toChatMessage(EVERY_MEMBER, row('admins')).sender).toEqual({
      id: 'sender-1',
      displayName: 'Lan',
    });
    const admin = { id: 'admin-1', role: 'admin' as const, displayName: 'Admin' };
    expect(toChatMessage(admin, row('admins')).sender.avatarMediaId).toBe('avatar-1');
  });

  it('R-PROF-04 never carries a contact field, the preferred name or the bio', () => {
    const text = JSON.stringify(toChatMessage(EVERY_MEMBER, row('members')));
    for (const value of ['lan@example.test', '+84', 'Huế', 'Lan Anh', '"bio"']) {
      expect(text).not.toContain(value);
    }
  });

  it('R-CHAT-03 a tombstone has no body', () => {
    const message = toChatMessage(EVERY_MEMBER, row('members', 1_800_000_000_500));
    expect(message).toEqual({
      id: '01900000-0000-7000-8000-0000000000aa',
      createdAt: 1_800_000_000_000,
      sender: { id: 'sender-1', displayName: 'Lan', avatarMediaId: 'avatar-1' },
      deleted: true,
    });
    expect(chatMessageSchema.parse(message)).not.toHaveProperty('body');
  });
});

describe('chat frames (R-CHAT-01, R-CHAT-05)', () => {
  it('R-CHAT-01 trims, then counts code points: 1-1,000', () => {
    expect(chatBodySchema.parse('  hi  ')).toBe('hi');
    expect(chatBodySchema.safeParse(' \n\t ').success).toBe(false);
    expect(chatBodySchema.safeParse('a'.repeat(1_000)).success).toBe(true);
    expect(chatBodySchema.safeParse('a'.repeat(1_001)).success).toBe(false);
    // 1,000 emoji are 2,000 UTF-16 units but 1,000 characters.
    expect(chatBodySchema.safeParse('🎓'.repeat(1_000)).success).toBe(true);
    expect(chatBodySchema.safeParse('🎓'.repeat(1_001)).success).toBe(false);
  });

  it('R-CHAT-04 a frame names only its nonce and body, never who sent it', () => {
    const nonce = crypto.randomUUID();
    expect(
      clientFrameSchema.safeParse({ type: 'send', clientNonce: nonce, body: 'x' }).success,
    ).toBe(true);
    for (const frame of [
      { type: 'send', clientNonce: nonce, body: 'x', senderId: 'someone' },
      { type: 'send', clientNonce: 'not-a-uuid', body: 'x' },
      { type: 'delete', id: nonce },
      { type: 'send', clientNonce: nonce },
    ]) {
      expect(clientFrameSchema.safeParse(frame).success).toBe(false);
    }
  });
});
