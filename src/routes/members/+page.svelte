<script lang="ts">
  import { resolve } from '$app/paths';
  import Avatar from '$lib/components/Avatar.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import GalleryGrid from '$lib/components/GalleryGrid.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const i18n = useI18n();
</script>

<PageHeader title={i18n.t('home.classmates')} lede={i18n.t('members.lede')}>
  {#snippet actions()}
    <form class="search" method="GET" role="search">
      <FormField
        id="member-search"
        name="q"
        type="search"
        label={i18n.t('members.search')}
        placeholder={i18n.t('members.search')}
        value={data.q}
        maxlength={80}
        labelHidden
      />
      <Button type="submit">{i18n.t('members.searchButton')}</Button>
    </form>
  {/snippet}
</PageHeader>

{#if data.items.length === 0}
  <EmptyState title={data.q ? i18n.t('members.empty', { q: data.q }) : i18n.t('members.none')} />
{:else}
  <div class="people">
    <GalleryGrid columns={6}>
      {#each data.items as person, index (person.id)}
        <Card class="person">
          <a class="link" href={resolve('/members/[id]', { id: person.id })}>
            <Avatar
              name={person.displayName}
              size="lg"
              tone={index}
              mediaId={person.avatarMediaId}
            />
            <b>{person.displayName}</b>
            {#if person.preferredName}<small>{person.preferredName}</small>{/if}
            {#if person.city}<small>{person.city}</small>{/if}
          </a>
        </Card>
      {/each}
    </GalleryGrid>
  </div>
{/if}

{#if data.paged || data.nextCursor}
  <nav class="pages" aria-label={i18n.t('home.classmates')}>
    {#if data.paged}
      <form method="GET">
        {#if data.q}<input type="hidden" name="q" value={data.q} />{/if}
        <Button type="submit" variant="ghost">{i18n.t('members.first')}</Button>
      </form>
    {/if}
    {#if data.nextCursor}
      <form class="next" method="GET">
        {#if data.q}<input type="hidden" name="q" value={data.q} />{/if}
        <input type="hidden" name="cursor" value={data.nextCursor} />
        <Button type="submit">{i18n.t('common.next')}</Button>
      </form>
    {/if}
  </nav>
{/if}

<style>
  .search {
    display: flex;
    flex: none;
    gap: calc(var(--space-unit) * 2);
    align-items: end;
    /* As wide as the old field: it fits the 390 px header without stretching it. */
    width: 22rem;
    max-width: 100%;
  }

  .search :global(.field) {
    flex: 1;
    min-width: 0;
  }

  /* A name, a nickname and a city do not fit a square card at 390 px or in six
     columns: the cards take their content's height, and a row shares the tallest. */
  .people :global(.person) {
    aspect-ratio: auto;
    padding: 0;
  }

  .link {
    display: grid;
    justify-items: center;
    align-content: start;
    gap: calc(var(--space-unit) * 1.5);
    height: 100%;
    padding: calc(var(--space-unit) * 3);
    border-radius: inherit;
    color: inherit;
    text-align: center;
    text-decoration: none;
  }

  .link b {
    font-size: 0.9375rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .link small {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .pages {
    display: flex;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
    margin-top: calc(var(--space-unit) * 6);
  }

  .next {
    margin-left: auto;
  }
</style>
