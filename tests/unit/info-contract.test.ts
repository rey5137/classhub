import { describe, expect, it } from 'vitest';
import { infoCreateSchema, infoPatchSchema, infoSlugSchema } from '../../src/lib/contracts/info';

describe('R-BRD-02 info page limits', () => {
  it('a slug is 1–40 of [a-z0-9-]', () => {
    for (const slug of ['a', 'reunion', 'hop-lop-2026', 'a'.repeat(40)]) {
      expect(infoSlugSchema.safeParse(slug).success, slug).toBe(true);
    }
    for (const slug of ['', 'a'.repeat(41), 'Reunion', 'họp-lớp', 'a b', 'a/b', 'a_b', '../x']) {
      expect(infoSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it('title 1–160 after trimming, body up to 20,000, defaults for the rest', () => {
    expect(infoCreateSchema.parse({ slug: 'a', title: '  Hi  ' })).toEqual({
      slug: 'a',
      title: 'Hi',
      body: '',
      isPinned: false,
      sortOrder: 0,
    });
    const ok = { slug: 'a', title: 't'.repeat(160), body: 'b'.repeat(20_000) };
    expect(infoCreateSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { slug: 'a', title: '   ' },
      { slug: 'a', title: 't'.repeat(161) },
      { slug: 'a', title: 'x', body: 'b'.repeat(20_001) },
      { slug: 'a', title: 'x\u0007' },
      { slug: 'a', title: 'x', sortOrder: 1.5 },
      { slug: 'a', title: 'x', sortOrder: 10_000 },
      { slug: 'a', title: 'x', extra: true },
    ]) {
      expect(infoCreateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a patch is partial and strict', () => {
    expect(infoPatchSchema.parse({})).toEqual({});
    expect(infoPatchSchema.parse({ isPinned: true })).toEqual({ isPinned: true });
    expect(infoPatchSchema.safeParse({ bodyHtml: '<p>' }).success).toBe(false);
  });
});
