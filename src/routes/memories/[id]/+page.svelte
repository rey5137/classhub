<script lang="ts">
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();
</script>

<PageHeader title={i18n.t('photo.title')} lede={i18n.t('photo.body')}>
  {#snippet actions()}
    <Button>{i18n.t('photo.delete')}</Button>
  {/snippet}
</PageHeader>

<div class="photo-page">
  <Card class="photo-card">
    <span class="photo" role="img" aria-label={i18n.t('demo.copy63')}></span>
    <div class="meta">
      <p>{i18n.t('demo.copy63')}</p>
      <small>{i18n.t('demo.copy74')}</small>
    </div>
  </Card>
</div>

<style>
  .photo-page :global(.photo-card) {
    overflow: hidden;
    max-width: 52rem;
  }

  .photo {
    display: block;
    aspect-ratio: 4 / 3;
    background: linear-gradient(
      140deg,
      var(--color-surface-2),
      color-mix(in srgb, var(--color-accent) 18%, var(--color-surface))
    );
  }

  .meta {
    display: grid;
    gap: var(--space-unit);
    padding: calc(var(--space-unit) * 4) calc(var(--space-unit) * 5);
  }

  small {
    color: var(--color-muted);
    font-size: 0.875rem;
  }
</style>
