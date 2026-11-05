<script lang="ts">
  import { resolve } from '$app/paths';
  import type { AppHref } from '$lib/nav';

  interface Props {
    title: string;
    meta: string;
    time?: string;
    href?: AppHref;
    pinned?: boolean;
    isNew?: boolean;
    pinnedLabel?: string;
    newLabel?: string;
  }

  let { title, meta, time, href, pinned, isNew, pinnedLabel = '', newLabel = '' }: Props = $props();
</script>

<article class="post">
  <div class="line">
    <h3>
      {#if pinned}<span class="pin">{pinnedLabel}</span>{/if}
      {#if href}<a href={resolve(href)}>{title}</a>{:else}{title}{/if}
      {#if isNew}<span class="new">{newLabel}</span>{/if}
    </h3>
    {#if time}<time class="tnum">{time}</time>{/if}
  </div>
  <p class="meta">{meta}</p>
</article>

<style>
  .post {
    display: grid;
    gap: calc(var(--space-unit) * 0.5);
    padding: calc(var(--space-unit) * 3.5) calc(var(--space-unit) * 5);
    border-top: 1px solid var(--color-divider);
  }

  .post:first-child {
    border-top: 0;
  }

  .line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 4);
  }

  h3 {
    font-size: 1rem;
    font-weight: 600;
    min-width: 0;
  }

  a:hover {
    color: var(--color-accent);
  }

  .meta {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  time {
    flex: none;
    color: var(--color-muted);
    font-size: 0.875rem;
    text-align: right;
  }

  .pin {
    margin-right: calc(var(--space-unit) * 2);
    color: var(--color-accent);
    font-size: 0.8125rem;
    font-weight: 700;
  }

  .new {
    display: inline-block;
    margin-left: calc(var(--space-unit) * 2);
    padding: 1px calc(var(--space-unit) * 2);
    border-radius: 999px;
    background: var(--color-mark);
    color: var(--color-mark-contrast);
    font-size: 0.75rem;
    font-weight: 700;
    vertical-align: 2px;
    line-height: 1.5;
  }
</style>
