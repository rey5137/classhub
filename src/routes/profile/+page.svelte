<script lang="ts">
  import Avatar from '$lib/components/Avatar.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();
</script>

<PageHeader title={i18n.t('prof.title')} lede={i18n.t('prof.lede')} />

<div class="profile-page">
  <Card class="profile">
    <div class="identity">
      <Avatar name={i18n.t('demo.copy22')} size="lg" />
      <div class="fields">
        <FormField id="profile-name" label={i18n.t('prof.name')} value={i18n.t('demo.copy22')} />
        <FormField id="profile-city" label={i18n.t('prof.city')} value={i18n.t('demo.copy23')} />
        <FormField
          id="profile-bio"
          label={i18n.t('prof.bio')}
          multiline
          value={i18n.t('demo.copy54')}
        />
        <FormField
          id="profile-visibility"
          label={i18n.t('prof.visibility')}
          value={i18n.t('prof.visibility.members')}
        />
      </div>
    </div>
    <div class="actions">
      <Button variant="primary">{i18n.t('prof.save')}</Button>
      <Button>{i18n.t('prof.export')}</Button>
      <Button variant="ghost">{i18n.t('prof.delete')}</Button>
    </div>
  </Card>
</div>

<style>
  .profile-page :global(.profile) {
    display: grid;
    gap: calc(var(--space-unit) * 6);
    padding: calc(var(--space-unit) * 5);
  }

  .identity {
    display: grid;
    gap: calc(var(--space-unit) * 4);
  }

  @media (min-width: 768px) {
    .identity {
      grid-template-columns: auto 1fr;
      align-items: start;
    }
  }

  .fields {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    max-width: 32rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2);
  }
</style>
