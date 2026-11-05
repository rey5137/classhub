<script lang="ts">
  import type { Snippet } from 'svelte';
  import { siteConfig } from '$lib/config';

  interface Props {
    title: string;
    lede?: string;
    actions?: Snippet;
  }

  let { title, lede, actions }: Props = $props();
</script>

<!-- WCAG 2.4.2: one distinct, translated document title per route. -->
<svelte:head><title>{title} · {siteConfig.appName}</title></svelte:head>

<header class="page-header">
  <div class="heading">
    <h1>{title}</h1>
    {#if lede}<p class="lede">{lede}</p>{/if}
  </div>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</header>

<style>
  .page-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 4);
    margin-bottom: calc(var(--space-unit) * 7);
  }

  .heading {
    min-width: 0;
  }

  h1 {
    font: var(--text-display);
    color: var(--color-heading);
    overflow-wrap: anywhere;
  }

  .lede {
    margin-top: calc(var(--space-unit) * 1.5);
    color: var(--color-muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2);
  }
</style>
