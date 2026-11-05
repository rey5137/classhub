<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends HTMLButtonAttributes {
    variant?: 'primary' | 'secondary' | 'ghost';
    children: Snippet;
  }

  let {
    variant = 'secondary',
    type = 'button',
    children,
    class: className = '',
    ...rest
  }: Props = $props();
</script>

<button {type} class="btn {variant} {className}" {...rest}>{@render children()}</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(var(--space-unit) * 2);
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 4.5);
    border-radius: var(--radius-control);
    font-weight: 600;
    font-size: 0.9375rem;
    white-space: nowrap;
  }

  .primary {
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .secondary {
    border: 1px solid var(--color-border);
    color: var(--color-text);
  }

  .ghost {
    color: var(--color-accent);
    padding: 0 calc(var(--space-unit) * 2);
  }

  .btn:disabled {
    opacity: var(--color-dim);
    cursor: not-allowed;
  }
</style>
