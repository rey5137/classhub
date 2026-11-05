<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open?: boolean;
    title: string;
    onclose?: () => void;
    children: Snippet;
  }

  let { open = false, title, onclose, children }: Props = $props();

  let dialog: HTMLDialogElement;

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} aria-label={title} {onclose}>
  <h2>{title}</h2>
  {@render children()}
</dialog>

<style>
  dialog {
    max-width: min(32rem, calc(100vw - 2rem));
    padding: calc(var(--space-unit) * 6);
    border: 1px solid var(--color-divider);
    border-radius: var(--radius-card);
    background: var(--color-surface);
    color: var(--color-text);
  }

  dialog::backdrop {
    background: color-mix(in srgb, var(--color-bg) 70%, transparent);
  }

  h2 {
    font: var(--text-heading);
    color: var(--color-accent);
    margin-bottom: calc(var(--space-unit) * 3);
  }
</style>
