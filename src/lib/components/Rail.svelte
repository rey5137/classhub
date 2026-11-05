<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
    label: string;
  }

  let { children, label }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="rail" role="region" aria-label={label} tabindex="0">{@render children()}</div>

<style>
  .rail {
    display: flex;
    align-items: flex-start;
    gap: calc(var(--space-unit) * 2.5);
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    margin: 0 calc(var(--space-unit) * -4);
    padding: calc(var(--space-unit) * 1) calc(var(--space-unit) * 4) calc(var(--space-unit) * 1.5);
  }

  .rail::-webkit-scrollbar {
    display: none;
  }

  @media (min-width: 768px) {
    .rail {
      margin: 0;
      padding: calc(var(--space-unit) * 1) calc(var(--space-unit) * 1) calc(var(--space-unit) * 1.5);
    }
  }
</style>
