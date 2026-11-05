<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
    columns?: 5 | 6;
  }

  let { children, columns = 5 }: Props = $props();
</script>

<div class="gallery" class:six={columns === 6}>{@render children()}</div>

<style>
  .gallery {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
  }

  .gallery.six {
    gap: calc(var(--space-unit) * 3);
  }

  @media (min-width: 768px) {
    .gallery {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }

    .gallery.six {
      grid-template-columns: repeat(6, minmax(0, 1fr));
    }
  }

  .gallery > :global(*) {
    aspect-ratio: 1;
    min-width: 0;
  }

  .gallery > :global(.cell:nth-child(10n + 1)) {
    background: var(--placeholder-6);
  }
  .gallery > :global(.cell:nth-child(10n + 2)) {
    background: var(--placeholder-7);
  }
  .gallery > :global(.cell:nth-child(10n + 3)) {
    background: var(--placeholder-8);
  }
  .gallery > :global(.cell:nth-child(10n + 4)) {
    background: var(--placeholder-9);
  }
  .gallery > :global(.cell:nth-child(10n + 5)) {
    background: var(--placeholder-10);
  }
  .gallery > :global(.cell:nth-child(10n + 6)) {
    background: var(--placeholder-1);
  }
  .gallery > :global(.cell:nth-child(10n + 7)) {
    background: var(--placeholder-2);
  }
  .gallery > :global(.cell:nth-child(10n + 8)) {
    background: var(--placeholder-3);
  }
  .gallery > :global(.cell:nth-child(10n + 9)) {
    background: var(--placeholder-4);
  }
  .gallery > :global(.cell:nth-child(10n)) {
    background: var(--placeholder-5);
  }
</style>
