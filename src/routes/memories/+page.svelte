<script lang="ts">
  import Button from '$lib/components/Button.svelte';
  import GalleryGrid from '$lib/components/GalleryGrid.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Rail from '$lib/components/Rail.svelte';
  import Row from '$lib/components/Row.svelte';
  import Tile from '$lib/components/Tile.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();

  const years = ['2004', '2005', '2006', '2007'];
  const albums = $derived([
    {
      title: i18n.t('demo.copy27'),
      meta: i18n.t('mem.albumMeta', { month: '03', year: 2006, count: 14 }),
      photos: [
        { title: i18n.t('demo.copy63'), meta: i18n.t('demo.copy64') },
        { title: i18n.t('demo.copy65'), meta: i18n.t('demo.copy4') },
        { title: i18n.t('demo.copy66'), meta: i18n.t('demo.copy22') },
        { title: i18n.t('demo.copy67'), meta: i18n.t('demo.copy12') },
        { title: i18n.t('demo.copy68'), meta: i18n.t('demo.copy10') },
      ],
    },
    {
      title: i18n.t('demo.copy5'),
      meta: i18n.t('mem.albumMeta', { month: '11', year: 2005, count: 9 }),
      photos: [
        { title: i18n.t('demo.copy69'), meta: i18n.t('demo.copy6') },
        { title: i18n.t('demo.copy70'), meta: i18n.t('demo.copy6') },
        { title: i18n.t('demo.copy71'), meta: i18n.t('demo.copy4') },
        { title: i18n.t('demo.copy72'), meta: i18n.t('demo.copy8') },
        { title: i18n.t('demo.copy73'), meta: i18n.t('demo.copy56') },
      ],
    },
  ]);

  let activeYear = $state('all');
  let view = $state<'row' | 'grid'>('row');
</script>

<PageHeader title={i18n.t('mem.title')} lede={i18n.t('mem.lede')}>
  {#snippet actions()}
    <Button variant="primary">{i18n.t('mem.add')}</Button>
  {/snippet}
</PageHeader>

<div class="controls">
  <div class="chips" role="group" aria-label={i18n.t('mem.yearChips')}>
    <button class="chip" aria-pressed={activeYear === 'all'} onclick={() => (activeYear = 'all')}
      >{i18n.t('mem.allYears')}</button
    >
    {#each years as year (year)}
      <button class="chip" aria-pressed={activeYear === year} onclick={() => (activeYear = year)}
        >{year}</button
      >
    {/each}
  </div>
  <div class="seg" role="group" aria-label={i18n.t('mem.viewMode')}>
    <button aria-pressed={view === 'row'} onclick={() => (view = 'row')}>{i18n.t('mem.row')}</button
    >
    <button aria-pressed={view === 'grid'} onclick={() => (view = 'grid')}
      >{i18n.t('mem.grid')}</button
    >
  </div>
</div>

<div class="wall">
  {#each albums as album, albumIndex (album.title)}
    <Row
      title={album.title}
      meta={album.meta}
      href="/memories/photo-demo"
      linkLabel={i18n.t('mem.openAlbum')}
    >
      {#if view === 'row'}
        <Rail label={album.title}>
          {#each album.photos as photo, index (photo.title)}
            <Tile
              title={photo.title}
              meta={photo.meta}
              tone={albumIndex * 5 + index + 5}
              grow={albumIndex === 0 && index === 0}
              isNew={albumIndex === 0 && index === 0}
            />
          {/each}
        </Rail>
      {:else}
        <GalleryGrid>
          {#each album.photos as photo (photo.title)}
            <span class="cell" role="img" aria-label={photo.title}></span>
          {/each}
        </GalleryGrid>
      {/if}
    </Row>
  {/each}
  <Row
    title={i18n.t('demo.copy9')}
    meta={i18n.t('mem.albumMeta', { month: '05', year: 2007, count: 22 })}
    href="/memories/photo-demo"
    linkLabel={i18n.t('mem.openAlbum')}
  >
    <GalleryGrid>
      {#each albums.flatMap((album) => album.photos) as photo (photo.title)}
        <span class="cell" role="img" aria-label={photo.title}></span>
      {/each}
    </GalleryGrid>
  </Row>
</div>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
    margin-bottom: calc(var(--space-unit) * 7);
  }

  .chips {
    display: flex;
    gap: calc(var(--space-unit) * 2);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .chip,
  .seg button {
    min-height: 44px;
    min-width: 44px;
    padding: 0 calc(var(--space-unit) * 3.5);
    border: 1px solid var(--color-border);
    font-size: 0.875rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .chip {
    border-radius: 999px;
  }

  .chip[aria-pressed='true'],
  .seg button[aria-pressed='true'] {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .seg {
    display: inline-flex;
    border-radius: var(--radius-control);
    overflow: hidden;
  }

  .seg button {
    border-radius: 0;
  }

  .wall {
    display: grid;
    gap: calc(var(--space-unit) * 8);
  }

  .cell {
    display: block;
  }
</style>
