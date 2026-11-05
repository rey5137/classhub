<script lang="ts">
  import { resolve } from '$app/paths';
  import { useI18n } from '$lib/i18n/context';
  import type { AppHref } from '$lib/nav';

  interface Props {
    title: string;
    meta?: string;
    href?: AppHref;
    isNew?: boolean;
    grow?: boolean;
    onclick?: () => void;
    tone?: number;
  }

  let { title, meta, href, isNew = false, grow = false, onclick, tone = 0 }: Props = $props();

  const i18n = useI18n();
</script>

{#snippet inner()}
  <span class="ph" style:background={`var(--placeholder-${(tone % 10) + 1})`} aria-hidden="true"
  ></span>
  {#if isNew}<span class="new">{i18n.t('common.new')}</span>{/if}
  <span class="cap">
    <b>{title}</b>
    {#if meta}<small>{meta}</small>{/if}
  </span>
{/snippet}

{#if href}
  <a class="tile" class:grow href={resolve(href)}>{@render inner()}</a>
{:else}
  <button type="button" class="tile" class:grow {onclick}>{@render inner()}</button>
{/if}

<style>
  .tile {
    position: relative;
    flex: none;
    display: block;
    width: 156px;
    aspect-ratio: 4 / 3;
    border-radius: var(--radius-control);
    overflow: hidden;
    transition: width 0.15s ease-out;
    text-align: left;
    scroll-snap-align: start;
  }

  @media (min-width: 768px) {
    .tile {
      width: 220px;
    }
  }

  .tile.grow,
  .tile:hover,
  .tile:focus-visible {
    width: 236px;
  }

  @media (min-width: 768px) {
    .tile.grow,
    .tile:hover,
    .tile:focus-visible {
      width: 340px;
    }
  }

  .ph {
    position: absolute;
    inset: 0;
  }

  .cap {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: calc(var(--space-unit) * 6) calc(var(--space-unit) * 3) calc(var(--space-unit) * 2.5);
    background: linear-gradient(transparent, color-mix(in srgb, var(--color-bg) 92%, transparent));
    opacity: 0;
    transition: opacity 0.15s ease-out;
  }

  .tile.grow .cap,
  .tile:hover .cap,
  .tile:focus-visible .cap {
    opacity: 1;
  }

  b {
    display: block;
    color: var(--color-text);
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.3;
  }

  small {
    color: var(--color-muted);
    font-size: 0.8125rem;
  }

  .new {
    position: absolute;
    top: calc(var(--space-unit) * 2);
    left: calc(var(--space-unit) * 2);
    padding: 1px calc(var(--space-unit) * 2);
    border-radius: 999px;
    background: var(--color-mark);
    color: var(--color-mark-contrast);
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1.5;
  }
</style>
