import { describe, expect, it } from 'vitest';
import {
  commentCreateSchema,
  commentPatchSchema,
  postCreateSchema,
  postPatchSchema,
} from '../../src/lib/contracts/discussions';
import {
  ALLOWED_TAGS,
  createExcerpt,
  extractPhotoIds,
  renderMarkdown,
  sanitizeHref,
  sanitizeHtml,
  type ReferencedPhoto,
} from '../../src/lib/server/markdown';
import { parse } from '../../src/lib/server/services/admin';

function assertOnlyAllowedHtml(html: string) {
  const tagRegex = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g;
  for (const match of html.matchAll(tagRegex)) {
    const tag = match[1]!;
    const attrs = match[2]!;
    expect(ALLOWED_TAGS.has(tag), `unexpected tag <${tag}> in ${html}`).toBe(true);
    if (tag === 'a' && !match[0].startsWith('</')) {
      expect(attrs).toMatch(
        /^ href="https:\/\/[^"]+" rel="noopener noreferrer nofollow"$|^ href="mailto:[^"]+" rel="noopener noreferrer nofollow"$|^ href="\/[^/\\][^"]*" rel="noopener noreferrer nofollow"$|^ href="[#?][^"]*" rel="noopener noreferrer nofollow"$|^ href="[a-zA-Z0-9._-]+(?:\/[^"]*)?" rel="noopener noreferrer nofollow"$/,
      );
      expect(attrs).not.toMatch(/on[a-z]+\s*=|style\s*=|javascript:|data:|vbscript:/i);
    } else {
      expect(attrs, `unexpected attrs on <${tag}>: ${attrs}`).toBe('');
    }
  }
}

describe('Markdown renderer and allow-list sanitizer (R-BRD-03, R-BRD-04)', () => {
  it('AC-BRD-01 runs without a DOM and renders the R-BRD-03 Markdown subset', () => {
    expect(typeof document).toBe('undefined');
    const md = [
      '# Heading one',
      '## Heading two',
      '### Heading three',
      '',
      'A paragraph with **bold**, *italic*, `inline code`, and a',
      'second line.',
      '',
      '- first bullet',
      '- second bullet',
      '',
      '1. first numbered',
      '2. second numbered',
      '',
      '> A quote with [a link](https://example.com/path?a=1&b=2)',
      '> and [a mailto](mailto:class@example.test) and [relative](/memories/123).',
      '',
      '![Campfire photo](https://example.com/image.webp)',
      '',
      '| col1 | col2 |',
      '| ---- | ---- |',
      '| a    | b    |',
    ].join('\n');

    const html = renderMarkdown(md);
    assertOnlyAllowedHtml(html);
    expect(html).toContain('<h3>Heading one</h3><h3>Heading two</h3><h3>Heading three</h3>');
    expect(html).not.toMatch(/<h[12456]/i);
    expect(html).toContain(
      '<p>A paragraph with <strong>bold</strong>, <em>italic</em>, <code>inline code</code>, and a<br>second line.</p>',
    );
    expect(html).toContain('<ul><li>first bullet</li><li>second bullet</li></ul>');
    expect(html).toContain('<ol><li>first numbered</li><li>second numbered</li></ol>');
    expect(html).toContain(
      '<blockquote><p>A quote with <a href="https://example.com/path?a=1&amp;b=2" rel="noopener noreferrer nofollow">a link</a><br>and <a href="mailto:class@example.test" rel="noopener noreferrer nofollow">a mailto</a> and <a href="/memories/123" rel="noopener noreferrer nofollow">relative</a>.</p></blockquote>',
    );
    expect(html).toContain('<p>Campfire photo</p>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<table');
  });

  it('AC-BRD-01 renders a hostile corpus of Markdown and HTML to allow-listed HTML only', () => {
    const hostileCorpus = [
      '<script>alert(1)</script>',
      '<ScRiPt src="https://evil.test/x.js">alert(1)</sCrIpT>',
      '<<script>script>alert(1)<</script>/script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)><circle /></svg>',
      '<iframe src="https://evil.test"></iframe>',
      '<style>body{display:none}</style>',
      '[js](javascript:alert(1))',
      '[js-caps](JaVaScRiPt:alert(1))',
      '[js-ws](   java\t\n\rscript:alert(1))',
      '[js-dec](&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert(1))',
      '[js-hex](&#x6a;&#x61;&#x76;&#x61;script:alert(1))',
      '[js-no-semi](&#0000106avascript:alert(1))',
      '[js-colon](javascript&#58;alert(1))',
      '[js-named-colon](javascript&colon;alert(1))',
      '[js-tab-entity](java&#x09;script:alert(1))',
      '[js-null-entity](java&#0;script:alert(1))',
      '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[vbscript](vbscript:msgbox(1))',
      '[http](http://example.com/insecure)',
      '[proto-rel](//evil.test/steal)',
      '[backslash-rel](/\\evil.test/steal)',
      '[nested-quotes](https://example.com/a"onmouseover="alert(1))',
      '`<a href="javascript:alert(1)" onclick="alert(1)">in-code</a>`',
      '```\n<script>alert("fenced")</script>\n<a href="javascript:alert(1)">code</a>\n```',
      '> > Nested quote with <b onclick="alert(1)">raw html</b> and **bold**',
      'Unclosed tags: <strong>bold <em>italic <a href="https://example.com">link <script>evil',
      'Incomplete tag at end <img src=x onerror=alert(1)',
    ];

    for (const sample of hostileCorpus) {
      const rendered = renderMarkdown(sample);
      assertOnlyAllowedHtml(rendered);
      expect(rendered).not.toMatch(
        /<(?:script|img|svg|iframe|style)\b|<[^>]+\bon(?:error|click|mouseover|load)\s*=/i,
      );
      expect(rendered).not.toMatch(/href="[^"]*(?:javascript|data|vbscript):/i);

      // Defence in depth: passing the raw sample directly to sanitizeHtml must also emit only allowed HTML.
      const directSanitized = sanitizeHtml(sample);
      assertOnlyAllowedHtml(directSanitized);
      expect(directSanitized).not.toMatch(
        /<(?:script|img|svg|iframe|style)\b|<[^>]+\bon(?:error|click|mouseover|load)\s*=/i,
      );
      expect(directSanitized).not.toMatch(/href="[^"]*(?:javascript|data|vbscript):/i);
    }

    // Raw HTML tokens in Markdown render escaped as text; direct sanitizeHtml strips disallowed tags/attrs.
    expect(renderMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(sanitizeHtml('<script>alert(1)</script>')).toBe('');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>')).toBe('');

    // Specifically verify `<a href` inside `code` and mixed-case tags in direct sanitizer calls.
    expect(sanitizeHtml('<code><a href="javascript:alert(1)">x</a></code>')).toBe(
      '<code>&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;</code>',
    );
    expect(
      sanitizeHtml('<A HREF="HTTPS://EXAMPLE.COM/ok" ONERROR="alert(1)"><STRONG>Hi</STRONG></A>'),
    ).toBe(
      '<a href="https://example.com/ok" rel="noopener noreferrer nofollow"><strong>Hi</strong></a>',
    );
    expect(sanitizeHtml('<a href=\'https://example.com/a" onclick="alert(1)\'>quote</a>')).toBe(
      'quote',
    );
    expect(
      sanitizeHtml(
        '<a title=\'nested "quote" onclick=alert(1)\' href="https://example.com/ok">quote</a>',
      ),
    ).toBe('<a href="https://example.com/ok" rel="noopener noreferrer nofollow">quote</a>');
    expect(sanitizeHtml('<strong><em>unclosed')).toBe('<strong><em>unclosed</em></strong>');
    expect(sanitizeHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeHref('https://example.com/ok')).toBe('https://example.com/ok');
  });

  it('R-BRD-04 renders live [[photo:<id>]] thumbnails after sanitizing and placeholders for deleted/unknown ids', () => {
    const liveId = '01900000-0000-7000-8000-000000000001';
    const upperLiveId = '01900000-0000-7000-8000-000000000001'.toUpperCase();
    const noCaptionId = '01900000-0000-7000-8000-000000000002';
    const deletedId = '01900000-0000-7000-8000-000000000003';
    const md = `See [[photo:${liveId}]] and [[photo:${upperLiveId}]] and [[photo:${noCaptionId}]] and [[photo:${deletedId}]] and [[photo:not-a-uuid]] and \`[[photo:${liveId}]]\`.`;

    expect(extractPhotoIds([md])).toEqual([liveId, noCaptionId, deletedId]);

    const photos = new Map<string, ReferencedPhoto>([
      [liveId, { id: liveId, caption: 'Trại hè "2006" <lớp>' }],
      [noCaptionId, { id: noCaptionId, caption: null }],
    ]);

    const viHtml = renderMarkdown(md, { locale: 'vi', photos });
    expect(
      viHtml.match(
        new RegExp(
          `<a href="/memories/${liveId}" rel="noopener noreferrer nofollow"><img src="/api/v1/media/${liveId}/thumb" alt="Trại hè &quot;2006&quot; &lt;lớp&gt;"></a>`,
          'g',
        ),
      ),
    ).toHaveLength(2);
    expect(viHtml).toContain(
      `<a href="/memories/${noCaptionId}" rel="noopener noreferrer nofollow"><img src="/api/v1/media/${noCaptionId}/thumb" alt="Ảnh của lớp"></a>`,
    );
    expect(viHtml).toContain('<em>Ảnh đã gỡ</em>');
    expect(viHtml).toContain(`<code>[[photo:${liveId}]]</code>`);

    // Finding 1 & 6 & round 2: photo tokens or entity-forged markers in href, link label, code span, or mailto must stay literal/refused and pass allow-list check.
    const inLinksMd = [
      `[in-href](https://example.com/[[photo:${liveId}]])`,
      `[[[photo:${liveId}]]](https://example.com/ok)`,
      `[label [[photo:${liveId}]] text](https://example.com/ok)`,
      `[in-mailto](mailto:user[[photo:${liveId}]]@example.test)`,
      `\`[[photo:${liveId}]]\``,
      `[hex-entity](https://a.com/&#xe000;PHOTO:${liveId}&#xe001;)`,
      `[hex-nosemi](https://a.com/&#xe000PHOTO:${liveId}&#xe001)`,
      `[dec-entity](https://a.com/&#57344;PHOTO:${liveId}&#57345;)`,
      `[dec-nosemi](https://a.com/&#57344PHOTO:${liveId}&#57345)`,
      `[mailto-entity](mailto:a&#xe000;PHOTO:${liveId}&#xe001;@b.c)`,
      `Guessed marker: \ue000PHOTO:00000000000000000000000000000000:${liveId}\ue001`,
    ].join('\n\n');
    const inLinksHtml = renderMarkdown(inLinksMd, { locale: 'vi', photos });
    assertOnlyAllowedHtml(inLinksHtml);
    expect(inLinksHtml).not.toContain('<img');
    expect(inLinksHtml).not.toContain('Ảnh đã gỡ');
    expect(inLinksHtml).toContain(`[[photo:${liveId}]]`);
    expect(inLinksHtml).toContain(`PHOTO:00000000000000000000000000000000:${liveId}`);

    // Finding 3: at most 10 distinct photo references per body are expanded; extras become the placeholder.
    const twelveIds = Array.from(
      { length: 12 },
      (_, i) => `01900000-0000-7000-8000-${String(i + 10).padStart(12, '0')}`,
    );
    const twelveMap = new Map<string, ReferencedPhoto>(
      twelveIds.map((id) => [id, { id, caption: `Ảnh ${id.slice(-2)}` }]),
    );
    const twelveMd = twelveIds.map((id) => `[[photo:${id}]]`).join(' ');
    expect(extractPhotoIds([twelveMd])).toEqual(twelveIds.slice(0, 10));
    const twelveHtml = renderMarkdown(twelveMd, { locale: 'vi', photos: twelveMap });
    expect(twelveHtml.match(/<img /g)).toHaveLength(10);
    expect(twelveHtml.match(/<em>Ảnh đã gỡ<\/em>/g)).toHaveLength(2);

    const enHtml = renderMarkdown(`[[photo:${noCaptionId}]] [[photo:${deletedId}]]`, {
      locale: 'en',
      photos,
    });
    expect(enHtml).toContain('alt="Class photo"');
    expect(enHtml).toContain('<em>Photo removed</em>');

    // Excerpt strips Markdown syntax and photo tokens, collapses whitespace, and cuts at a word ≤ 200 chars with "…".
    expect(
      createExcerpt(
        `### Tiêu đề\n> Trích dẫn **in đậm** và *nghiêng* cùng [[photo:${liveId}]] và [liên kết](https://example.com) ![ảnh](https://example.com/a.webp)`,
      ),
    ).toBe('Tiêu đề Trích dẫn in đậm và nghiêng cùng và liên kết ảnh');
    const longWords = Array.from(
      { length: 40 },
      (_, i) => `tu${String(i).padStart(2, '0')}abc`,
    ).join(' ');
    const cutExcerpt = createExcerpt(longWords);
    expect(cutExcerpt.length).toBeLessThanOrEqual(200);
    expect(cutExcerpt.endsWith('…')).toBe(true);
    expect(cutExcerpt.slice(0, -1).endsWith('abc')).toBe(true);
  });

  // In Cloudflare Workers (`workerd`), `performance.now()` does not advance during synchronous
  // CPU work, so the CPU benchmark runs only in the Node `unit` project.
  const isWorkersRuntime =
    typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

  it.skipIf(isWorkersRuntime)(
    'AC-BRD-01 renders and sanitizes a 10,000-character mixed/hostile post and pathological inputs under 5 ms median',
    () => {
      const chunk =
        '### Kỷ niệm lớp 12A\nĐoạn **in đậm** và *in nghiêng* với `code <a href="javascript:alert(1)">` cùng [liên kết](https://example.com/lop-12a) và [xấu](javascript&#58;alert(1)) <script>alert(1)</script>.\n- Mục một\n- Mục hai\n> Trích dẫn lớp học\n\n';
      const largePost = chunk.repeat(Math.ceil(10_000 / chunk.length)).slice(0, 10_000);
      expect(largePost.length).toBe(10_000);

      const bracketFlood = '['.repeat(10_000);
      const unclosedParenFlood = '['.repeat(5_000) + '](' + '('.repeat(4_995);
      const emphasisBacktickFlood = '**a *b _c `d '.repeat(800).slice(0, 10_000);
      const hostileComment = '['.repeat(1_000) + '](' + '('.repeat(995);

      const measureMedian = (fn: () => void): number => {
        fn();
        const samples: number[] = [];
        for (let i = 0; i < 15; i += 1) {
          const t0 = performance.now();
          fn();
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length / 2)]!;
      };

      expect(measureMedian(() => renderMarkdown(largePost))).toBeLessThan(5);
      expect(measureMedian(() => renderMarkdown(bracketFlood))).toBeLessThan(5);
      expect(measureMedian(() => renderMarkdown(unclosedParenFlood))).toBeLessThan(5);
      expect(measureMedian(() => renderMarkdown(emphasisBacktickFlood))).toBeLessThan(5);
      expect(
        measureMedian(() => {
          for (let i = 0; i < 20; i += 1) renderMarkdown(hostileComment);
        }),
      ).toBeLessThan(5);
    },
  );

  it('AC-BRD-06 refuses empty or over-length titles, post bodies and comments with field errors after trimming (R-BRD-05)', () => {
    expect(
      parse(postCreateSchema, {
        title: `  ${'t'.repeat(160)}  `,
        body: `  ${'b'.repeat(10_000)}  `,
      }),
    ).toEqual({
      ok: true,
      data: { title: 't'.repeat(160), body: 'b'.repeat(10_000) },
    });

    expect(parse(postCreateSchema, { title: '   ', body: 'ok' })).toEqual({
      ok: false,
      code: 'validation',
      fields: { title: 'too_small' },
    });

    expect(parse(postCreateSchema, { title: 't'.repeat(161), body: 'b'.repeat(10_001) })).toEqual({
      ok: false,
      code: 'validation',
      fields: { title: 'too_big', body: 'too_big' },
    });

    expect(parse(postPatchSchema, {})).toEqual({
      ok: false,
      code: 'validation',
      fields: { _: 'custom' },
    });

    expect(parse(postPatchSchema, { title: 't'.repeat(161), body: '   ' })).toEqual({
      ok: false,
      code: 'validation',
      fields: { title: 'too_big', body: 'too_small' },
    });

    expect(parse(commentCreateSchema, { body: `  ${'c'.repeat(2_000)}  ` })).toEqual({
      ok: true,
      data: { body: 'c'.repeat(2_000) },
    });

    expect(parse(commentCreateSchema, { body: '   ' })).toEqual({
      ok: false,
      code: 'validation',
      fields: { body: 'too_small' },
    });

    expect(parse(commentCreateSchema, { body: 'c'.repeat(2_001) })).toEqual({
      ok: false,
      code: 'validation',
      fields: { body: 'too_big' },
    });

    expect(parse(commentPatchSchema, { body: 'c'.repeat(2_001) })).toEqual({
      ok: false,
      code: 'validation',
      fields: { body: 'too_big' },
    });
  });
});
