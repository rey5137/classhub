import { t, type Locale } from '../../i18n';

// R-BRD-03, R-BRD-04, R-PLAT-05: a hand-written linear-time Markdown renderer, excerpt
// builder, and allow-list HTML sanitizer with zero external dependencies and no DOM.

export const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'h3',
]);

export const MAX_PHOTOS_PER_BODY = 10;
export const EXCERPT_MAX_CHARS = 200;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  tab: '\t',
  newline: '\n',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIVE_ORIGIN = 'https://classhub.internal';
const MAX_LINK_LABEL_LEN = 1_000;
const MAX_LINK_URL_LEN = 1_024;
const MAX_PHOTO_ID_LEN = 64;

function createRenderNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export interface ReferencedPhoto {
  id: string;
  caption: string | null;
}

export interface RenderMarkdownOptions {
  locale?: Locale;
  photos?: ReadonlyMap<string, ReferencedPhoto>;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodeEntitiesOnce(value: string): string {
  return value.replace(
    /&(?:#(\d+);?|#x([0-9a-fA-F]+);?|([a-zA-Z0-9]+);?)/g,
    (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (dec !== undefined) {
        const code = Number.parseInt(dec, 10);
        return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '\u0000';
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '\u0000';
      }
      if (named !== undefined) {
        const key = named.toLowerCase();
        if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key]!;
      }
      return match;
    },
  );
}

function decodeEntitiesAll(value: string): string {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeEntitiesOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function hasUnsafeHrefChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0xe000 || code === 0xe001) return true;
    const ch = value[i];
    if (ch === '"' || ch === "'" || ch === '<' || ch === '>' || ch === '\\') return true;
  }
  return false;
}

function stripAsciiWhitespaceAndControls(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0x20 && code !== 0x7f) out += value[i];
  }
  return out;
}

/**
 * R-BRD-03: only `https:`, `mailto:` and same-origin relative URLs survive.
 * Entity- and control-character-obfuscated schemes (`javascript:`, `data:`, `vbscript:`) are refused.
 */
export function sanitizeHref(rawHref: string): string | null {
  const once = decodeEntitiesOnce(rawHref).trim();
  const decoded = decodeEntitiesAll(rawHref).trim();
  if (!once || !decoded) return null;
  if (hasUnsafeHrefChar(once) || hasUnsafeHrefChar(decoded)) {
    return null;
  }

  const compact = stripAsciiWhitespaceAndControls(decoded);
  if (
    !compact ||
    compact.startsWith('//') ||
    compact.startsWith('/\\') ||
    compact.startsWith('\\')
  ) {
    return null;
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (scheme === 'https') {
      try {
        const parsed = new URL(decoded);
        if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
        return decoded.replace(/^https:\/\/[^/?#]+/i, (m) => m.toLowerCase());
      } catch {
        return null;
      }
    }
    if (scheme === 'mailto') {
      const address = decoded.slice(schemeMatch[0].length).trim();
      if (!address || /[\s<>\\]/.test(address)) return null;
      return `mailto:${address}`;
    }
    return null;
  }

  if (compact.includes(':')) return null;

  try {
    const resolved = new URL(decoded, `${RELATIVE_ORIGIN}/a/b`);
    if (resolved.origin !== RELATIVE_ORIGIN) return null;
    return decoded;
  } catch {
    return null;
  }
}

interface ParsedTag {
  end: number;
  closing: boolean;
  name: string;
  attrs: string;
}

function readTagAt(html: string, start: number): ParsedTag | null {
  const len = html.length;
  let i = start + 1;
  if (i >= len) return null;

  if (html.startsWith('!--', i)) {
    const closeComment = html.indexOf('-->', i + 3);
    return {
      end: closeComment === -1 ? len : closeComment + 3,
      closing: false,
      name: '!comment',
      attrs: '',
    };
  }

  let closing = false;
  if (html[i] === '/') {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  while (i < len && /[a-zA-Z0-9]/.test(html[i]!)) i += 1;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();

  const attrStart = i;
  let quote: '"' | "'" | null = null;
  while (i < len) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return {
        end: i + 1,
        closing,
        name,
        attrs: html.slice(attrStart, i),
      };
    } else if (ch === '<') {
      return null;
    }
    i += 1;
  }
  return null;
}

function extractHrefAttr(attrs: string): string | null {
  let i = 0;
  const len = attrs.length;
  let foundHref: string | null = null;

  while (i < len) {
    while (i < len && /[\s/]/.test(attrs[i]!)) i += 1;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>"']/.test(attrs[i]!)) i += 1;
    const attrName = attrs.slice(nameStart, i).toLowerCase();
    while (i < len && /\s/.test(attrs[i]!)) i += 1;

    let attrValue = '';
    if (attrs[i] === '=') {
      i += 1;
      while (i < len && /\s/.test(attrs[i]!)) i += 1;
      if (i < len && (attrs[i] === '"' || attrs[i] === "'")) {
        const quote = attrs[i]!;
        i += 1;
        const valStart = i;
        while (i < len && attrs[i] !== quote) i += 1;
        attrValue = attrs.slice(valStart, i);
        if (i < len) i += 1;
      } else {
        const valStart = i;
        while (i < len && !/\s/.test(attrs[i]!)) i += 1;
        attrValue = attrs.slice(valStart, i);
      }
    } else if (!attrName) {
      i += 1;
    }

    if (attrName === 'href' && foundHref === null) {
      foundHref = attrValue;
    }
  }
  return foundHref;
}

function escapeTextNode(text: string): string {
  return escapeHtml(decodeEntitiesOnce(text));
}

/**
 * R-BRD-03: strict allow-list HTML sanitizer running without a DOM.
 * Safe on its own against hostile HTML input (defence in depth).
 */
export function sanitizeHtml(input: string): string {
  let out = '';
  const openStack: { name: string; emitted: boolean }[] = [];
  let i = 0;
  const len = input.length;

  const isInside = (tagName: string) =>
    openStack.some((entry) => entry.emitted && entry.name === tagName);

  while (i < len) {
    const inCode = openStack.at(-1)?.emitted && openStack.at(-1)?.name === 'code';
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out += escapeTextNode(input.slice(i));
      break;
    }
    if (lt > i) {
      out += escapeTextNode(input.slice(i, lt));
      i = lt;
    }

    const parsed = readTagAt(input, i);
    if (!parsed) {
      out += '&lt;';
      i += 1;
      continue;
    }

    if (inCode && !(parsed.closing && parsed.name === 'code')) {
      out += escapeTextNode(input.slice(i, parsed.end));
      i = parsed.end;
      continue;
    }

    if (parsed.name === 'script' || parsed.name === 'style') {
      if (!parsed.closing) {
        const closeRe = new RegExp(`<\\s*/\\s*${parsed.name}\\s*>`, 'i');
        const match = closeRe.exec(input.slice(parsed.end));
        i = match ? parsed.end + match.index + match[0].length : len;
      } else {
        i = parsed.end;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(parsed.name)) {
      i = parsed.end;
      continue;
    }

    if (parsed.name === 'br') {
      if (!parsed.closing) out += '<br>';
      i = parsed.end;
      continue;
    }

    if (parsed.closing) {
      let matchIdx = -1;
      for (let s = openStack.length - 1; s >= 0; s -= 1) {
        if (openStack[s]!.name === parsed.name) {
          matchIdx = s;
          break;
        }
      }
      if (matchIdx !== -1) {
        while (openStack.length > matchIdx) {
          const popped = openStack.pop()!;
          if (popped.emitted) out += `</${popped.name}>`;
        }
      }
      i = parsed.end;
      continue;
    }

    if (parsed.name === 'a') {
      const rawHref = extractHrefAttr(parsed.attrs);
      const safeHref = rawHref !== null ? sanitizeHref(rawHref) : null;
      if (safeHref && !isInside('a')) {
        const escapedHref = escapeHtml(safeHref)
          .replaceAll('\ue000', '&#xe000;')
          .replaceAll('\ue001', '&#xe001;');
        out += `<a href="${escapedHref}" rel="noopener noreferrer nofollow">`;
        openStack.push({ name: 'a', emitted: true });
      } else {
        openStack.push({ name: 'a', emitted: false });
      }
      i = parsed.end;
      continue;
    }

    out += `<${parsed.name}>`;
    openStack.push({ name: parsed.name, emitted: true });
    i = parsed.end;
  }

  while (openStack.length > 0) {
    const popped = openStack.pop()!;
    if (popped.emitted) out += `</${popped.name}>`;
  }

  return out;
}

function replaceDoubleDelimiter(text: string, delim: '**' | '__', tag: string): string {
  let first = text.indexOf(delim);
  if (first === -1) return text;
  let out = '';
  let i = 0;
  while (first !== -1) {
    const second = text.indexOf(delim, first + 2);
    if (second === -1) break;
    if (second === first + 2) {
      out += text.slice(i, first + 1);
      i = first + 1;
      first = text.indexOf(delim, i);
      continue;
    }
    out += `${text.slice(i, first)}<${tag}>${text.slice(first + 2, second)}</${tag}>`;
    i = second + 2;
    first = text.indexOf(delim, i);
  }
  return i === 0 ? text : out + text.slice(i);
}

function renderFormatting(escaped: string): string {
  const withStrong = replaceDoubleDelimiter(
    replaceDoubleDelimiter(escaped, '**', 'strong'),
    '__',
    'strong',
  );
  return withStrong
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?:;)])/g, '$1<em>$2</em>');
}

function findBalancedParen(text: string, openIdx: number): number {
  const limit = Math.min(text.length, openIdx + MAX_LINK_URL_LEN);
  let depth = 0;
  for (let i = openIdx; i < limit; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return -1;
    const ch = text[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      if (depth > 2) return -1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface MatchedLink {
  start: number;
  openBracket: number;
  mid: number;
  end: number;
  isImage: boolean;
  nextMidSearch: number;
}

function findLinkOpenBracket(segment: string, fromIdx: number, mid: number): number {
  const minIdx = Math.max(fromIdx, mid - MAX_LINK_LABEL_LEN);
  let k = mid - 1;
  while (k >= minIdx) {
    const ch = segment[k]!;
    if (ch === ']') {
      if (k - 1 >= minIdx && segment[k - 1] === ']') {
        const photoStart = segment.lastIndexOf('[[photo:', k - 2);
        if (photoStart >= minIdx && k - 1 - (photoStart + 8) <= MAX_PHOTO_ID_LEN) {
          const inner = segment.slice(photoStart + 8, k - 1);
          if (inner.length > 0 && !/[\s[\]]/.test(inner)) {
            k = photoStart - 1;
            continue;
          }
        }
      }
      return -1;
    }
    if (ch === '[') return k;
    k -= 1;
  }
  return -1;
}

function findNextLink(segment: string, fromIdx: number, minMidIdx: number): MatchedLink {
  let searchFrom = Math.max(fromIdx + 1, minMidIdx);
  while (searchFrom < segment.length) {
    const mid = segment.indexOf('](', searchFrom);
    if (mid === -1) break;
    const openBracket = findLinkOpenBracket(segment, fromIdx, mid);
    if (openBracket === -1) {
      searchFrom = mid + 2;
      continue;
    }
    const closeParen = findBalancedParen(segment, mid + 1);
    if (closeParen === -1) {
      searchFrom = mid + 2;
      continue;
    }
    const isImage = openBracket > fromIdx && segment[openBracket - 1] === '!';
    return {
      start: isImage ? openBracket - 1 : openBracket,
      openBracket,
      mid,
      end: closeParen + 1,
      isImage,
      nextMidSearch: closeParen + 1,
    };
  }
  return {
    start: -1,
    openBracket: -1,
    mid: -1,
    end: -1,
    isImage: false,
    nextMidSearch: segment.length,
  };
}

interface PhotoParseState {
  seenIds: Set<string>;
  nonce: string;
}

function readPhotoTokenAt(segment: string, start: number): { end: number; rawId: string } | null {
  if (!segment.startsWith('[[photo:', start)) return null;
  const searchEnd = Math.min(segment.length, start + 8 + MAX_PHOTO_ID_LEN + 2);
  const close = segment.slice(start + 8, searchEnd).indexOf(']]');
  if (close <= 0) return null;
  const rawId = segment.slice(start + 8, start + 8 + close);
  if (/[\s[\]]/.test(rawId)) return null;
  return { end: start + 8 + close + 2, rawId };
}

function renderInlineSegment(segment: string, photoState: PhotoParseState): string {
  let out = '';
  let i = 0;
  const len = segment.length;
  let minMidIdx = 0;
  let nextLink = findNextLink(segment, 0, 0);
  let nextPhoto = segment.indexOf('[[photo:');

  while (i < len) {
    if (nextLink.start !== -1 && nextLink.start < i) {
      minMidIdx = Math.max(minMidIdx, i + 1);
      nextLink = findNextLink(segment, i, minMidIdx);
    }
    if (nextPhoto !== -1 && nextPhoto < i) {
      nextPhoto = segment.indexOf('[[photo:', i);
    }

    if (nextLink.start === i) {
      minMidIdx = nextLink.nextMidSearch;
      if (nextLink.isImage) {
        const alt = segment.slice(nextLink.openBracket + 1, nextLink.mid);
        out += escapeHtml(alt);
      } else {
        const label = segment.slice(nextLink.openBracket + 1, nextLink.mid);
        let rawUrl = segment.slice(nextLink.mid + 2, nextLink.end - 1).trim();
        if (rawUrl.startsWith('<') && rawUrl.endsWith('>')) {
          rawUrl = rawUrl.slice(1, -1).trim();
        }
        const safeHref = sanitizeHref(rawUrl);
        // Link labels never expand [[photo:...]] tokens.
        const inner = renderFormatting(escapeHtml(label));
        if (safeHref) {
          const escapedHref = escapeHtml(safeHref)
            .replaceAll('\ue000', '&#xe000;')
            .replaceAll('\ue001', '&#xe001;');
          out += `<a href="${escapedHref}" rel="noopener noreferrer nofollow">${inner}</a>`;
        } else {
          out += inner;
        }
      }
      i = nextLink.end;
      nextLink = findNextLink(segment, i, minMidIdx);
      continue;
    }

    if (nextPhoto === i) {
      const token = readPhotoTokenAt(segment, i);
      if (token) {
        const normalizedId = token.rawId.toLowerCase();
        let markerId = '__invalid__';
        if (UUID_RE.test(normalizedId)) {
          if (
            photoState.seenIds.has(normalizedId) ||
            photoState.seenIds.size < MAX_PHOTOS_PER_BODY
          ) {
            photoState.seenIds.add(normalizedId);
            markerId = normalizedId;
          }
        }
        out += `\ue000PHOTO:${photoState.nonce}:${markerId}\ue001`;
        i = token.end;
        nextPhoto = segment.indexOf('[[photo:', i);
        continue;
      }
      nextPhoto = segment.indexOf('[[photo:', i + 8);
    }

    let stop = len;
    if (nextLink.start !== -1 && nextLink.start < stop) stop = nextLink.start;
    if (nextPhoto !== -1 && nextPhoto < stop) stop = nextPhoto;
    if (stop <= i) stop = i + 1;

    out += renderFormatting(escapeHtml(segment.slice(i, stop)));
    i = stop;
  }

  return out;
}

function renderInline(line: string, photoState: PhotoParseState): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick === -1) {
      out += renderInlineSegment(line.slice(i), photoState);
      break;
    }
    if (tick > i) {
      out += renderInlineSegment(line.slice(i, tick), photoState);
    }
    const closeTick = line.indexOf('`', tick + 1);
    if (closeTick === -1) {
      out += renderInlineSegment(line.slice(tick), photoState);
      break;
    }
    out += `<code>${escapeHtml(line.slice(tick + 1, closeTick))}</code>`;
    i = closeTick + 1;
  }
  return out;
}

function renderBlocks(lines: string[], photoState: PhotoParseState): string {
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (/^`{3,}/.test(line.trim())) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^`{3,}/.test(lines[i]!.trim())) {
        codeLines.push(escapeHtml(lines[i]!));
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(`<p><code>${codeLines.join('\n')}</code></p>`);
      continue;
    }

    const headingMatch = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      const text = headingMatch[1]!.replace(/\s+#+\s*$/, '').trim();
      blocks.push(`<h3>${renderInline(text, photoState)}</h3>`);
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(`<blockquote>${renderBlocks(quoteLines, photoState)}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(
          `<li>${renderInline(lines[i]!.replace(/^\s*[-*+]\s+/, '').trim(), photoState)}</li>`,
        );
        i += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(
          `<li>${renderInline(lines[i]!.replace(/^\s*\d+\.\s+/, '').trim(), photoState)}</li>`,
        );
        i += 1;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^`{3,}/.test(lines[i]!.trim()) &&
      !/^\s*#{1,6}\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      paraLines.push(renderInline(lines[i]!.trim(), photoState));
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push(`<p>${paraLines.join('<br>')}</p>`);
    }
  }

  return blocks.join('');
}

function replacePhotoMarkers(
  sanitizedHtml: string,
  nonce: string,
  locale: Locale,
  photos?: ReadonlyMap<string, ReferencedPhoto>,
): string {
  const removedText = escapeHtml(t(locale, 'brd.photoRemoved'));
  const fallbackAlt = t(locale, 'brd.photoAlt');
  const markerRe = new RegExp(`\\ue000PHOTO:${nonce}:([a-z0-9_-]+)\\ue001`, 'g');

  return sanitizedHtml.replace(markerRe, (_, id: string) => {
    const photo = photos?.get(id.toLowerCase());
    if (!photo) return `<em>${removedText}</em>`;
    const alt = escapeHtml(photo.caption?.trim() || fallbackAlt);
    const safeId = escapeHtml(photo.id);
    return `<a href="/memories/${safeId}" rel="noopener noreferrer nofollow"><img src="/api/v1/media/${safeId}/thumb" alt="${alt}"></a>`;
  });
}

/**
 * R-BRD-04: unique lowercase UUID photo ids referenced via top-level `[[photo:<id>]]`
 * (at most `MAX_PHOTOS_PER_BODY` distinct ids per body).
 */
export function extractPhotoIds(markdownBodies: readonly string[]): string[] {
  const pageIds = new Set<string>();
  for (const body of markdownBodies) {
    const normalized = body.replace(/\r\n?/g, '\n').trim();
    if (!normalized || !normalized.includes('[[photo:')) continue;
    const photoState: PhotoParseState = { seenIds: new Set(), nonce: 'extract' };
    renderBlocks(normalized.split('\n'), photoState);
    for (const id of photoState.seenIds) pageIds.add(id);
  }
  return [...pageIds];
}

/**
 * R-BRD-03, R-BRD-04: renders the Markdown subset, cleans through `sanitizeHtml`,
 * and expands only parser-emitted per-render nonced photo markers after sanitizing.
 */
export function renderMarkdown(markdown: string, options: RenderMarkdownOptions = {}): string {
  const normalized = markdown.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const nonce = normalized.includes('[[photo:') ? createRenderNonce() : '';
  const photoState: PhotoParseState = { seenIds: new Set(), nonce };
  const rawHtml = renderBlocks(normalized.split('\n'), photoState);
  const cleanHtml = sanitizeHtml(rawHtml);
  if (!nonce || !cleanHtml.includes(`\ue000PHOTO:${nonce}:`)) return cleanHtml;
  return replacePhotoMarkers(cleanHtml, nonce, options.locale ?? 'vi', options.photos);
}

function stripInlinePlain(segment: string): string {
  let out = '';
  let i = 0;
  const len = segment.length;
  let minMidIdx = 0;
  let nextLink = findNextLink(segment, 0, 0);
  let nextPhoto = segment.indexOf('[[photo:');

  while (i < len) {
    if (nextLink.start !== -1 && nextLink.start < i) {
      minMidIdx = Math.max(minMidIdx, i + 1);
      nextLink = findNextLink(segment, i, minMidIdx);
    }
    if (nextPhoto !== -1 && nextPhoto < i) {
      nextPhoto = segment.indexOf('[[photo:', i);
    }

    if (nextLink.start === i) {
      minMidIdx = nextLink.nextMidSearch;
      const label = segment.slice(nextLink.openBracket + 1, nextLink.mid);
      out += label.replace(/[*_`~]/g, '');
      i = nextLink.end;
      nextLink = findNextLink(segment, i, minMidIdx);
      continue;
    }

    if (nextPhoto === i) {
      const token = readPhotoTokenAt(segment, i);
      if (token) {
        i = token.end;
        nextPhoto = segment.indexOf('[[photo:', i);
        continue;
      }
      nextPhoto = segment.indexOf('[[photo:', i + 8);
    }

    let stop = len;
    if (nextLink.start !== -1 && nextLink.start < stop) stop = nextLink.start;
    if (nextPhoto !== -1 && nextPhoto < stop) stop = nextPhoto;
    if (stop <= i) stop = i + 1;

    out += segment.slice(i, stop).replace(/[*_`~]/g, '');
    i = stop;
  }

  return out;
}

/**
 * R-BRD-06: linear-time plain-text excerpt for the board list (Markdown syntax and
 * photo tokens stripped, whitespace collapsed, ≤ 200 chars, cut at a word with `…`).
 */
export function createExcerpt(markdown: string, maxChars: number = EXCERPT_MAX_CHARS): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const parts: string[] = [];
  let collectedLen = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^`{3,}/.test(trimmed)) continue;
    const strippedBlock = trimmed
      .replace(/^(?:>\s*)+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+#+\s*$/, '')
      .replace(/^(?:[-*+]|\d+\.)\s+/, '');
    const plainLine = stripInlinePlain(strippedBlock).replace(/\s+/g, ' ').trim();
    if (!plainLine) continue;
    parts.push(plainLine);
    collectedLen += plainLine.length + 1;
    if (collectedLen > maxChars + 120) break;
  }

  const collapsed = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;

  const limit = Math.max(1, maxChars - 1);
  if (collapsed[limit] === ' ') {
    return `${collapsed.slice(0, limit).trimEnd()}…`;
  }
  const lastSpace = collapsed.lastIndexOf(' ', limit);
  const cut = lastSpace > 0 ? collapsed.slice(0, lastSpace).trimEnd() : collapsed.slice(0, limit);
  return `${cut}…`;
}
