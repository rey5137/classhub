<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import type { AppHref } from '$lib/nav';

  interface Props {
    title: string;
    meta?: string;
    href?: AppHref;
    linkLabel?: string;
    children: Snippet;
  }

  let { title, meta, href, linkLabel, children }: Props = $props();
</script>

<section class="row">
  <div class="rowhead">
    <h2>
      {title}
      {#if meta}<small class="tnum">{meta}</small>{/if}
    </h2>
    {#if href && linkLabel}<a href={resolve(href)}>{linkLabel}</a>{/if}
  </div>
  {@render children()}
</section>

<style>
  .row {
    min-width: 0;
    transition: opacity 0.15s ease-out;
  }

  .rowhead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
    margin-bottom: calc(var(--space-unit) * 3);
  }

  h2 {
    font: var(--text-title);
    color: var(--color-heading);
    min-width: 0;
  }

  small {
    margin-left: calc(var(--space-unit) * 2.5);
    color: var(--color-muted);
    font: var(--text-small);
    letter-spacing: 0;
  }

  a {
    flex: none;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    min-width: 44px;
    color: var(--color-accent);
    font-size: 0.875rem;
    font-weight: 600;
  }

  @media (max-width: 767px) {
    small {
      display: block;
      margin: calc(var(--space-unit) * 0.5) 0 0;
    }
  }
</style>
