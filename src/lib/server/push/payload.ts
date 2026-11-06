import { pluralKey, t, type Locale } from '../../i18n';
import { toBase64Url } from './vapid';

// R-NTF-03: per-kind encrypted payload renderer and Web Push request headers.

export type PushKind = 'chat' | 'thread' | 'reply' | 'join' | 'summary';

export interface PushPayload {
  kind: PushKind;
  title: string;
  body: string;
  url: string;
  tag: string;
  /** Chat only: the merged-title template in the subscription's locale; the worker fills `{n}`. */
  merge?: string;
}

export interface PushAuthorInput {
  displayName: string;
  preferredName?: string | null;
  deletionRequestedAt?: number | null;
  authEmail?: string | null;
  contactEmail?: string | null;
  phone?: string | null;
}

export type PushPayloadInput =
  | {
      kind: 'chat';
      locale: Locale;
      sender: string | PushAuthorInput;
      message: string;
    }
  | {
      kind: 'thread';
      locale: Locale;
      author: string | PushAuthorInput;
      threadId: string;
      threadTitle: string;
    }
  | {
      kind: 'reply';
      locale: Locale;
      author: string | PushAuthorInput;
      postId: string;
      threadTitle: string;
      comment: string;
    }
  | {
      kind: 'join';
      locale: Locale;
      requestedName: string;
    }
  | {
      kind: 'summary';
      locale: Locale;
      siteName: string;
      counts: {
        chat?: number;
        thread?: number;
        reply?: number;
      };
    };

const MAX_BODY_CHARS = 120;
const MAX_REPLY_THREAD_CHARS = 40;
const MAX_NAME_CHARS = 60;
const MAX_PAYLOAD_BYTES = 1024;
const encoder = new TextEncoder();

/**
 * R-NTF-03 / R-PROF-13: only the member's `displayName` is used in push titles;
 * never `authEmail`, contact fields, or a pending-deletion member's `preferredName`.
 */
export function resolvePushDisplayName(author: string | PushAuthorInput): string {
  const raw = typeof author === 'string' ? author : author.displayName;
  return stripAndCut(raw, MAX_NAME_CHARS);
}

/**
 * R-NTF-03: strips Markdown, links, and line breaks, collapses whitespace,
 * and cuts on a word boundary to at most `maxChars` characters with "…".
 */
export function stripAndCut(input: string, maxChars = MAX_BODY_CHARS): string {
  const stripped = input
    // Code fences -> inner text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ' '))
    // Inline code -> inner text
    .replace(/`([^`]*)`/g, '$1')
    // Markdown images ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Markdown links [label](url) -> label (URL stripped)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Auto-linked or bare URLs -> stripped
    .replace(/<https?:\/\/[^>]+>/gi, '')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    // Blockquote and heading markers at line start
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>+[ \t]*|[-*+][ \t]+)/gm, '')
    // Bold, italic, strikethrough markers
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    // Collapse all line breaks and whitespace runs
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped.length <= maxChars) return stripped;
  const budget = Math.max(1, maxChars - 1);
  const slice = stripped.slice(0, budget + 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = (lastSpace > 0 ? slice.slice(0, lastSpace) : stripped.slice(0, budget)).replace(
    /[\s.,;:!?-]+$/,
    '',
  );
  return `${cut || stripped.slice(0, budget)}…`;
}

function capCountLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function renderSummaryBody(
  locale: Locale,
  counts: { chat?: number; thread?: number; reply?: number },
): string {
  const parts: string[] = [];
  for (const [kind, base] of [
    ['chat', 'push.payload.summaryChat'],
    ['thread', 'push.payload.summaryThread'],
    ['reply', 'push.payload.summaryReply'],
  ] as const) {
    const count = counts[kind];
    if (count && count > 0) {
      parts.push(t(locale, pluralKey(locale, base, count), { count: capCountLabel(count) }));
    }
  }
  return parts.length > 0 ? parts.join(' · ') : t(locale, 'push.payload.summaryFallback');
}

/** R-NTF-03: renders the per-kind notification payload in the subscription's locale. */
export function renderPushPayload(input: PushPayloadInput): PushPayload {
  let payload: PushPayload;
  switch (input.kind) {
    case 'chat': {
      const name = resolvePushDisplayName(input.sender);
      payload = {
        kind: 'chat',
        title: name,
        body: stripAndCut(input.message, MAX_BODY_CHARS),
        url: '/chat',
        tag: 'chat',
        merge: t(input.locale, 'push.payload.chatMerged'),
      };
      break;
    }
    case 'thread': {
      const name = resolvePushDisplayName(input.author);
      payload = {
        kind: 'thread',
        title: t(input.locale, 'push.payload.threadTitle', { name }),
        body: stripAndCut(input.threadTitle, MAX_BODY_CHARS),
        url: `/discussions/${input.threadId}`,
        tag: `thread-${input.threadId}`,
      };
      break;
    }
    case 'reply': {
      const name = resolvePushDisplayName(input.author);
      const thread = stripAndCut(input.threadTitle, MAX_REPLY_THREAD_CHARS);
      payload = {
        kind: 'reply',
        title: t(input.locale, 'push.payload.replyTitle', { name, thread }),
        body: stripAndCut(input.comment, MAX_BODY_CHARS),
        url: `/discussions/${input.postId}`,
        tag: `reply-${input.postId}`,
      };
      break;
    }
    case 'join': {
      const name = stripAndCut(input.requestedName, MAX_NAME_CHARS);
      payload = {
        kind: 'join',
        title: t(input.locale, 'push.payload.joinTitle'),
        body: t(input.locale, 'push.payload.joinBody', { name }),
        url: '/admin#join',
        tag: 'join',
      };
      break;
    }
    case 'summary': {
      payload = {
        kind: 'summary',
        title: stripAndCut(input.siteName, MAX_NAME_CHARS),
        body: renderSummaryBody(input.locale, input.counts),
        url: '/',
        tag: 'summary',
      };
      break;
    }
  }

  // Ensure serialized JSON stays strictly under 1 KB (R-NTF-03).
  if (encoder.encode(JSON.stringify(payload)).byteLength >= MAX_PAYLOAD_BYTES) {
    payload = { ...payload, body: stripAndCut(payload.body, 60) };
  }
  return payload;
}

/**
 * R-NTF-03: RFC 8030 §5.4 `Topic` header must be <= 32 URL-safe base64 characters.
 * Short tags (`chat`, `join`, `summary`) stay verbatim; UUID-suffixed tags compact the UUID.
 */
export function topicHeaderForTag(tag: string): string {
  const safe = tag.replace(/[^A-Za-z0-9_-]/g, '-');
  if (safe.length <= 32) return safe;
  const uuidMatch =
    /^(thread|reply)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(tag);
  if (uuidMatch) {
    const prefix = uuidMatch[1]!;
    const hex = uuidMatch[2]!.replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return `${prefix}-${toBase64Url(bytes)}`.slice(0, 32);
  }
  return safe.slice(0, 32);
}

/** R-NTF-03: Web Push request headers (`TTL`, `Urgency`, `Topic`, `Content-Encoding`, `Authorization`). */
export function buildPushHeaders(
  kind: PushKind,
  tag: string,
  authorization: string,
): Record<string, string> {
  return {
    Authorization: authorization,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: kind === 'chat' ? '3600' : '86400',
    Urgency: kind === 'summary' ? 'low' : 'normal',
    Topic: topicHeaderForTag(tag),
  };
}
