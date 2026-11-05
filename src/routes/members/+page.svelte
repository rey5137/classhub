<script lang="ts">
  import Avatar from '$lib/components/Avatar.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import GalleryGrid from '$lib/components/GalleryGrid.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();

  const people = $derived([
    { name: i18n.t('demo.copy22'), city: i18n.t('demo.copy23') },
    { name: i18n.t('demo.copy4'), city: i18n.t('demo.copy24') },
    { name: i18n.t('demo.copy6'), city: i18n.t('demo.copy25') },
    { name: i18n.t('demo.copy8'), city: i18n.t('demo.copy26') },
    { name: i18n.t('demo.copy10'), city: i18n.t('demo.copy23') },
    { name: i18n.t('demo.copy12'), city: i18n.t('demo.copy55') },
    { name: i18n.t('demo.copy56'), city: i18n.t('demo.copy57') },
    { name: i18n.t('demo.copy58'), city: i18n.t('demo.copy59') },
    { name: i18n.t('demo.copy60'), city: i18n.t('demo.copy61') },
    { name: i18n.t('demo.copy62'), city: i18n.t('demo.copy23') },
  ]);
</script>

<PageHeader
  title={i18n.t('home.classmates')}
  lede={i18n.t('home.membersJoined', { joined: 32, total: 41 })}
>
  {#snippet actions()}
    <div class="search">
      <FormField
        id="member-search"
        type="search"
        label={i18n.t('members.search')}
        placeholder={i18n.t('members.search')}
        labelHidden
      />
    </div>
  {/snippet}
</PageHeader>

<div class="people">
  <GalleryGrid columns={6}>
    {#each people as person, index (person.name)}
      <Card class="person">
        <Avatar name={person.name} size="lg" tone={index} />
        <b>{person.name}</b>
        <small>{person.city}</small>
      </Card>
    {/each}
  </GalleryGrid>
</div>

<style>
  .search {
    flex: none;
    width: 22rem;
    max-width: 100%;
  }

  .people :global(.person) {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: calc(var(--space-unit) * 1.5);
    padding: calc(var(--space-unit) * 3);
    text-align: center;
  }

  .people :global(.person b) {
    font-size: 0.9375rem;
    font-weight: 600;
  }

  .people :global(.person small) {
    color: var(--color-muted);
    font-size: 0.875rem;
  }
</style>
