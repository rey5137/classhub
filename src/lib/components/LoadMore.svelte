<script module lang="ts">
  export { createPagedList, dedupByKey } from '$lib/client/paged-list.svelte';
</script>

<script lang="ts" generics="T">
  import type { PagedList } from '$lib/client/paged-list.svelte';
  import { useI18n } from '$lib/i18n/context';
  import Button from './Button.svelte';

  interface Props {
    pager: PagedList<T>;
    href?: (cursor: string) => string;
    variant?: 'link' | 'chip' | 'button';
  }

  let { pager, href, variant = 'link' }: Props = $props();
  const i18n = useI18n();
</script>

{#if pager.cursor}
  {#if href && variant !== 'button'}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- the caller builds `href` with resolve(); it is the no-JS fallback -->
    <a
      class={variant === 'chip' ? 'chip' : 'more'}
      href={href(pager.cursor)}
      aria-busy={pager.loading ? 'true' : undefined}
      aria-disabled={pager.loading ? 'true' : undefined}
      onclick={(event) => void pager.loadMore(event)}>{i18n.t('common.loadMore')}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {:else}
    <Button
      type="button"
      variant="ghost"
      disabled={pager.loading}
      onclick={() => void pager.loadMore()}
    >
      {i18n.t('common.loadMore')}
    </Button>
  {/if}
{/if}
<p class="sr-only" aria-live="polite" role="status">
  {#if pager.loadedMore}
    {i18n.t('common.loadedCount', { count: pager.items.length })}
  {/if}
</p>
{#if pager.error}
  <p class="error" role="alert">{pager.error}</p>
{/if}

<style>
  .more {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    min-width: 44px;
    padding: 0 calc(var(--space-unit) * 3.5);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text);
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }

  .more[aria-disabled='true'],
  .chip[aria-disabled='true'] {
    opacity: 0.6;
    pointer-events: none;
  }

  .error {
    margin: 0;
    color: var(--color-danger);
    font: var(--text-small);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
