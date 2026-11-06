<script lang="ts">
  import { resolve } from '$app/paths';
  import Card from '$lib/components/Card.svelte';
  import MarkdownBody from '$lib/components/MarkdownBody.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const i18n = useI18n();
</script>

<PageHeader title={data.page.title}>
  {#snippet actions()}
    <a class="back" href={resolve('/')}>{i18n.t('info.back')}</a>
  {/snippet}
</PageHeader>

<div class="info">
  <Card class="info-page">
    {#if data.page.bodyHtml}
      <MarkdownBody html={data.page.bodyHtml} />
    {:else}
      <p class="muted">{i18n.t('info.empty')}</p>
    {/if}
  </Card>
</div>

<style>
  .info :global(.info-page) {
    max-width: 46rem;
    padding: calc(var(--space-unit) * 6);
  }

  .back {
    color: var(--color-accent);
    font-weight: 600;
  }

  .muted {
    margin: 0;
    color: var(--color-muted);
  }
</style>
