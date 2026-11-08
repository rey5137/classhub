import { tick } from 'svelte';

export interface PagedList<T> {
  readonly items: T[];
  readonly cursor: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadedMore: boolean;
  loadMore: (event?: Event) => Promise<void>;
}

export function dedupByKey<T>(lists: readonly (readonly T[])[], keyOf: (item: T) => string): T[] {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to one call, never state
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function findByDataMoreItem(key: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-more-item]')) {
    if (el.dataset.moreItem === key) return el;
  }
  return null;
}

export function createPagedList<T>(options: {
  initialItems: () => readonly T[];
  initialCursor: () => string | null | undefined;
  keyOf: (item: T) => string;
  endpoint: (cursor: string) => string;
  fallbackError: () => string;
  focusItem?: (key: string) => { focus: () => void } | null;
  focusFallback?: () => { focus: () => void } | null;
  fetchImpl?: typeof fetch;
}): PagedList<T> {
  let state = $state<{
    base: readonly T[];
    extras: T[];
    cursor: string | null;
    error: string | null;
    loadedMore: boolean;
  } | null>(null);
  let loading = $state(false);

  const active = $derived(state?.base === options.initialItems() ? state : null);
  const items = $derived(dedupByKey([options.initialItems(), active?.extras ?? []], options.keyOf));
  const cursor = $derived(active ? active.cursor : (options.initialCursor() ?? null));
  const error = $derived(active?.error ?? null);
  const loadedMore = $derived(active?.loadedMore ?? false);

  async function loadMore(event?: Event) {
    event?.preventDefault();
    if (loading || !cursor) return;
    const base = options.initialItems();
    const currentExtras = state?.base === base ? state.extras : [];
    const currentCursor = cursor;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a snapshot for this call, never state
    const existingKeys = new Set(items.map(options.keyOf));
    const doFetch = options.fetchImpl ?? fetch;
    loading = true;
    state = {
      base,
      extras: currentExtras,
      cursor: currentCursor,
      error: null,
      loadedMore: state?.base === base ? state.loadedMore : false,
    };
    try {
      const response = await doFetch(options.endpoint(currentCursor));
      if (!response.ok) {
        let message = options.fallbackError();
        try {
          const errBody = (await response.json()) as { error?: { message?: string } };
          if (errBody?.error?.message) message = errBody.error.message;
        } catch {
          // keep fallbackError
        }
        state = {
          base,
          extras: currentExtras,
          cursor: currentCursor,
          error: message,
          loadedMore: state?.loadedMore ?? false,
        };
        return;
      }
      const body = (await response.json()) as {
        items: T[];
        nextCursor: string | null;
      };
      const mergedExtras = dedupByKey([currentExtras, body.items], options.keyOf);
      const firstNew = body.items.find((item) => !existingKeys.has(options.keyOf(item)));
      state = {
        base,
        extras: mergedExtras,
        cursor: body.nextCursor,
        error: null,
        loadedMore: true,
      };
      await tick();
      const firstKey = firstNew ? options.keyOf(firstNew) : null;
      const target =
        (firstKey ? (options.focusItem?.(firstKey) ?? findByDataMoreItem(firstKey)) : null) ??
        options.focusFallback?.();
      target?.focus();
    } catch {
      state = {
        base,
        extras: currentExtras,
        cursor: currentCursor,
        error: options.fallbackError(),
        loadedMore: state?.loadedMore ?? false,
      };
    } finally {
      loading = false;
    }
  }

  return {
    get items() {
      return items;
    },
    get cursor() {
      return cursor;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    get loadedMore() {
      return loadedMore;
    },
    loadMore,
  };
}
