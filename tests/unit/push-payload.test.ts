import { describe, expect, it } from 'vitest';
import { buildPushHeaders, renderPushPayload, topicHeaderForTag } from '../../src/lib/server/push';

const encoder = new TextEncoder();

describe('Web Push payload renderer and headers (R-NTF-03)', () => {
  const pendingDeletionSender = {
    displayName: 'Nguyễn Văn An',
    preferredName: 'An Bí Mật',
    deletionRequestedAt: 1_762_000_000_000,
    authEmail: 'an.secret@example.test',
    contactEmail: 'an.contact@example.test',
    phone: '+84901234567',
  };

  it('AC-NTF-03 renders each kind in vi and en with stripped text cut at 120 chars on a word boundary, under 1 KB, and never leaks email, contact or pending-deletion preferred_name', () => {
    const longMarkdown = [
      '# Heading text',
      'Check **bold words** and _italic_ with [our reunion plan](https://secret.example.test/plan?token=xyz) and bare https://secret.example.test/raw.',
      'Line two with `inline code` and more words '.repeat(90),
    ].join('\n');
    expect(longMarkdown.length).toBeGreaterThan(4000);

    for (const locale of ['vi', 'en'] as const) {
      const chat = renderPushPayload({
        kind: 'chat',
        locale,
        sender: pendingDeletionSender,
        message: longMarkdown,
      });
      expect(chat.kind).toBe('chat');
      expect(chat.title).toBe('Nguyễn Văn An');
      expect(chat.url).toBe('/chat');
      expect(chat.tag).toBe('chat');
      expect(chat.merge).toBe(
        locale === 'vi' ? 'Chat lớp · {n} tin nhắn mới' : 'Class chat · {n} new messages',
      );
      expect(chat.body.length).toBeLessThanOrEqual(120);
      expect(chat.body.endsWith('…')).toBe(true);
      expect(chat.body).not.toContain('**');
      expect(chat.body).not.toContain('https://');
      expect(chat.body).not.toContain('\n');
      expect(chat.body).toContain('our reunion plan');
      // Word-boundary cut: the word "inline" or "with" is not sliced mid-word.
      expect(chat.body).toMatch(/\b[a-z]+…$/i);

      const thread = renderPushPayload({
        kind: 'thread',
        locale,
        author: pendingDeletionSender,
        threadId: '01950000-0000-7000-8000-000000000001',
        threadTitle: longMarkdown,
      });
      expect(thread.title).toBe(
        locale === 'vi' ? 'Nguyễn Văn An · Thảo luận mới' : 'Nguyễn Văn An · New discussion',
      );
      expect(thread.url).toBe('/discussions/01950000-0000-7000-8000-000000000001');
      expect(thread.tag).toBe('thread-01950000-0000-7000-8000-000000000001');
      expect(thread.body.length).toBeLessThanOrEqual(120);

      const reply = renderPushPayload({
        kind: 'reply',
        locale,
        author: pendingDeletionSender,
        postId: '01950000-0000-7000-8000-000000000002',
        threadTitle:
          'A very long discussion title that exceeds forty characters easily when rendered',
        comment: longMarkdown,
      });
      expect(reply.title.startsWith('Nguyễn Văn An · ')).toBe(true);
      const cutThreadPart = reply.title.split(' · ')[1]!;
      expect(cutThreadPart.length).toBeLessThanOrEqual(40);
      expect(cutThreadPart.endsWith('…')).toBe(true);
      expect(reply.url).toBe('/discussions/01950000-0000-7000-8000-000000000002');
      expect(reply.tag).toBe('reply-01950000-0000-7000-8000-000000000002');
      expect(reply.body.length).toBeLessThanOrEqual(120);

      const join = renderPushPayload({
        kind: 'join',
        locale,
        requestedName: 'Trần Thị Bình',
      });
      expect(join.title).toBe(locale === 'vi' ? 'Yêu cầu tham gia' : 'Join request');
      expect(join.body).toBe(
        locale === 'vi' ? 'Trần Thị Bình muốn tham gia' : 'Trần Thị Bình wants to join',
      );
      expect(join.url).toBe('/admin#join');
      expect(join.tag).toBe('join');

      const summary = renderPushPayload({
        kind: 'summary',
        locale,
        siteName: 'Lớp 12A',
        counts: { chat: 120, thread: 2, reply: 5 },
      });
      expect(summary.title).toBe('Lớp 12A');
      expect(summary.body).toBe(
        locale === 'vi'
          ? '99+ tin nhắn chat · 2 thảo luận mới · 5 phản hồi'
          : '99+ chat messages · 2 new discussions · 5 replies',
      );
      expect(summary.url).toBe('/');
      expect(summary.tag).toBe('summary');

      for (const item of [chat, thread, reply, join, summary]) {
        const json = JSON.stringify(item);
        expect(encoder.encode(json).byteLength).toBeLessThan(1024);
        expect(json).not.toContain('An Bí Mật');
        expect(json).not.toContain('an.secret@example.test');
        expect(json).not.toContain('an.contact@example.test');
        expect(json).not.toContain('+84901234567');
      }
    }
  });

  it('AC-NTF-03 strips blockquote markers without dropping the words after them', () => {
    const chat = renderPushPayload({
      kind: 'chat',
      locale: 'en',
      sender: pendingDeletionSender,
      message: '> into the woods\n>> into the night',
    });
    expect(chat.body).toBe('into the woods into the night');
  });

  it('AC-NTF-03 sets TTL, Urgency and <= 32-char URL-safe Topic headers per kind', () => {
    const chatHeaders = buildPushHeaders('chat', 'chat', 'vapid t=x, k=y');
    expect(chatHeaders.TTL).toBe('3600');
    expect(chatHeaders.Urgency).toBe('normal');
    expect(chatHeaders.Topic).toBe('chat');

    const summaryHeaders = buildPushHeaders('summary', 'summary', 'vapid t=x, k=y');
    expect(summaryHeaders.TTL).toBe('86400');
    expect(summaryHeaders.Urgency).toBe('low');
    expect(summaryHeaders.Topic).toBe('summary');

    const replyTag = 'reply-01950000-0000-7000-8000-000000000002';
    const topic = topicHeaderForTag(replyTag);
    expect(topic.length).toBeLessThanOrEqual(32);
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
});
