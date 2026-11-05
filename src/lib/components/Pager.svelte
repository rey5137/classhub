<script lang="ts">
  import { useI18n } from '$lib/i18n/context';

  interface Props {
    hasPrevious?: boolean;
    hasNext?: boolean;
    onprevious?: () => void;
    onnext?: () => void;
  }

  let { hasPrevious = false, hasNext = false, onprevious, onnext }: Props = $props();

  const i18n = useI18n();
</script>

<nav class="pager">
  <button type="button" disabled={!hasPrevious} onclick={onprevious}>
    {i18n.t('common.previous')}
  </button>
  <button type="button" disabled={!hasNext} onclick={onnext}>{i18n.t('common.next')}</button>
</nav>

<style>
  .pager {
    display: flex;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
    padding-top: calc(var(--space-unit) * 4);
  }

  button {
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    font-weight: 600;
  }

  button:disabled {
    opacity: var(--color-dim);
    cursor: not-allowed;
  }
</style>
