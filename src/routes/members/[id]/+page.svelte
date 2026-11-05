<script lang="ts">
  import Avatar from '$lib/components/Avatar.svelte';
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();
</script>

<PageHeader title={i18n.t('member.title')} lede={i18n.t('member.body')} />

<div class="member-page">
  <Card class="member">
    <Avatar name={i18n.t('demo.copy22')} size="lg" />
    <div>
      <h2>{i18n.t('demo.copy22')}</h2>
      <p class="muted">{i18n.t('demo.copy23')}</p>
    </div>
  </Card>
</div>

<style>
  .member-page :global(.member) {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 4);
    padding: calc(var(--space-unit) * 5);
  }

  h2 {
    font: var(--text-heading);
  }

  .muted {
    color: var(--color-muted);
    font-size: 0.9375rem;
  }
</style>
