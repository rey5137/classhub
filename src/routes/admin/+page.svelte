<script lang="ts">
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();

  const sections = [
    'admin.invites',
    'admin.members',
    'admin.settings',
    'admin.theme',
    'admin.usage',
    'admin.backup',
  ] as const;
</script>

<PageHeader title={i18n.t('admin.title')} lede={i18n.t('admin.lede')} />

<div class="sections">
  {#each sections as section (section)}
    <Card class="section">
      <h2>{i18n.t(section)}</h2>
    </Card>
  {/each}
</div>

<style>
  .sections {
    display: grid;
    gap: calc(var(--space-unit) * 3);
  }

  @media (min-width: 768px) {
    .sections {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .sections :global(.section) {
    padding: calc(var(--space-unit) * 5);
  }

  h2 {
    font: var(--text-heading);
  }
</style>
