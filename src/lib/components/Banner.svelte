<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    tone?: 'info' | 'warning' | 'danger';
    children: Snippet;
  }

  let { tone = 'info', children }: Props = $props();
</script>

<div class="banner {tone}" role="status">{@render children()}</div>

<style>
  .banner {
    padding: calc(var(--space-unit) * 3) calc(var(--space-unit) * 4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
  }

  .warning {
    border-color: var(--color-warning);
  }

  .danger {
    border-color: var(--color-danger);
  }
</style>
