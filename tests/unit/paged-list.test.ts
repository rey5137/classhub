import { describe, expect, it, vi } from 'vitest';
import { createPagedList, dedupByKey } from '../../src/lib/client/paged-list.svelte';

describe('paged-list (R-DB-07, Load more)', () => {
  it('de-duplicates items by key across initial items and extras', () => {
    const merged = dedupByKey(
      [
        [{ id: '1' }, { id: '2' }],
        [{ id: '2' }, { id: '3' }, { id: '3' }],
      ],
      (item) => item.id,
    );
    expect(merged.map((item) => item.id)).toEqual(['1', '2', '3']);
  });

  it('guards in-flight fetches on double-click, de-dups across pages, focuses first new item, and resets when data changes', async () => {
    let base = [{ id: '1' }, { id: '2' }];
    let initialCursor: string | null = 'c1';
    const focused: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi.fn(async (url: string) => {
      await gate;
      return new Response(
        JSON.stringify({
          items: [{ id: '2' }, { id: '3' }, { id: '3' }, { id: '4' }],
          nextCursor: url.includes('c1') ? 'c2' : null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const pager = createPagedList({
      initialItems: () => base,
      initialCursor: () => initialCursor,
      keyOf: (item) => item.id,
      endpoint: (cursor) => `/api/test?cursor=${cursor}`,
      fallbackError: () => 'fallback error',
      focusItem: (key) => ({ focus: () => focused.push(key) }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // Double-click while in flight sends only one request.
    const first = pager.loadMore();
    const second = pager.loadMore();
    expect(pager.loading).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(pager.loading).toBe(false);
    expect(pager.loadedMore).toBe(true);
    expect(pager.items.map((item) => item.id)).toEqual(['1', '2', '3', '4']);
    expect(pager.cursor).toBe('c2');
    expect(focused).toEqual(['3']);

    // When `data` reloads (e.g. after a form action's invalidateAll), extras and cursor reset.
    base = [{ id: '1' }];
    initialCursor = 'fresh';
    expect(pager.items.map((item) => item.id)).toEqual(['1']);
    expect(pager.cursor).toBe('fresh');
    expect(pager.loadedMore).toBe(false);
  });

  it('surfaces the server error message or fallback when a fetch fails', async () => {
    // Stable like `data.invites`: a new array means `data` reloaded, which resets the pager.
    const base = [{ id: '1' }];
    const pager = createPagedList({
      initialItems: () => base,
      initialCursor: () => 'c1',
      keyOf: (item) => item.id,
      endpoint: (cursor) => `/api/test?cursor=${cursor}`,
      fallbackError: () => 'Could not load more right now.',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    await pager.loadMore();
    expect(pager.error).toBe('Service temporarily unavailable');
    expect(pager.cursor).toBe('c1');

    const offline = createPagedList({
      initialItems: () => base,
      initialCursor: () => 'c1',
      keyOf: (item) => item.id,
      endpoint: (cursor) => `/api/test?cursor=${cursor}`,
      fallbackError: () => 'Could not load more right now.',
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });
    await offline.loadMore();
    expect(offline.error).toBe('Could not load more right now.');
    expect(offline.loading).toBe(false);
  });
});
