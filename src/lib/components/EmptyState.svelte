<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title?: string;
    body?: string;
    action?: Snippet;
  }

  let { title, body, action }: Props = $props();
</script>

<div class="empty">
  {#if title}<h2>{title}</h2>{/if}
  {#if body}<p>{body}</p>{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .empty {
    display: grid;
    justify-items: center;
    gap: calc(var(--space-unit) * 2);
    padding: calc(var(--space-unit) * 12) calc(var(--space-unit) * 4);
    text-align: center;
    background: var(--color-surface);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-card);
  }

  h2 {
    font: var(--text-heading);
    color: var(--color-accent);
  }

  p {
    max-width: 44ch;
    color: var(--color-muted);
  }

  .action {
    margin-top: calc(var(--space-unit) * 2);
  }
</style>
