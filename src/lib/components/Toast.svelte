<script lang="ts">
  interface Props {
    message: string;
    visible?: boolean;
  }

  let { message, visible = false }: Props = $props();
</script>

<div class="toast" class:visible role="status" aria-live="polite" inert={!visible}>{message}</div>

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(88px + env(safe-area-inset-bottom));
    z-index: 20;
    max-width: min(28rem, calc(100vw - 2rem));
    padding: calc(var(--space-unit) * 3) calc(var(--space-unit) * 4);
    border: 1px solid var(--color-divider);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: var(--shadow-card);
    transform: translate(-50%, calc(100% + 2rem));
    visibility: hidden;
    opacity: 0;
    transition:
      transform 0.15s ease-out,
      opacity 0.15s ease-out,
      visibility 0.15s;
  }

  @media (min-width: 768px) {
    .toast {
      bottom: calc(var(--space-unit) * 8);
    }
  }

  .visible {
    transform: translate(-50%, 0);
    visibility: visible;
    opacity: 1;
  }
</style>
