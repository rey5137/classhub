<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  interface Props extends HTMLAttributes<HTMLElement> {
    children: Snippet;
  }

  let { children, class: className = '', ...rest }: Props = $props();
</script>

<section class="card {className}" {...rest}>{@render children()}</section>

<style>
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-divider);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
    min-width: 0;
  }
</style>
