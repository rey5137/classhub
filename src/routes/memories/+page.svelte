<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import LoadMore, { createPagedList } from '$lib/components/LoadMore.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import UploadSheet from '$lib/components/UploadSheet.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const i18n = useI18n();
  let uploading = $state(false);
  const albumsPager = createPagedList({
    initialItems: () => data.albums,
    initialCursor: () => data.albumsNextCursor,
    keyOf: (entry) => entry.id,
    endpoint: (cursor) => `/api/v1/albums?cursor=${encodeURIComponent(cursor)}`,
    fallbackError: () => i18n.t('common.loadMoreFailed'),
    focusItem: () =>
      uploading && typeof document !== 'undefined'
        ? document.querySelector<HTMLElement>('#upload-album')
        : null,
    focusFallback: () =>
      typeof document !== 'undefined' ? document.querySelector<HTMLElement>('#upload-album') : null,
  });
  const albums = $derived(albumsPager.items);
  const album = $derived(albums.find((entry) => entry.id === data.filter.album) ?? null);

  /** A wall query that keeps the other filter; a new filter always starts at the newest page. */
  function wallQuery(next: {
    album?: string | null;
    year?: number | null;
    cursor?: string;
    albumsCursor?: string;
  }) {
    const albumId = next.album === undefined ? data.filter.album : next.album;
    const year = next.year === undefined ? data.filter.year : next.year;
    const params = [
      albumId ? `album=${encodeURIComponent(albumId)}` : '',
      year ? `year=${year}` : '',
      next.cursor ? `cursor=${encodeURIComponent(next.cursor)}` : '',
      next.albumsCursor ? `albumsCursor=${encodeURIComponent(next.albumsCursor)}` : '',
    ].filter(Boolean);
    return params.length ? `?${params.join('&')}` : '';
  }

  const failure = $derived(form && 'message' in form ? form.message : null);
  const saved = $derived(form && 'done' in form && form.done === 'albumSaved');
  const fieldError = (action: string, name: string) =>
    form?.action === action && 'fields' in form && form.fields && name in form.fields
      ? i18n.t('error.validation')
      : undefined;
</script>

{#snippet albumFields(action: string, prefix: string, values?: (typeof data.albums)[number])}
  <FormField
    id="{prefix}-name"
    name="name"
    label={i18n.t('mem.album.name')}
    value={values?.name ?? ''}
    maxlength={80}
    required
    error={fieldError(action, 'name')}
  />
  <FormField
    id="{prefix}-year"
    name="yearTag"
    label={i18n.t('mem.album.year')}
    hint={i18n.t('mem.upload.yearHint')}
    value={values?.yearTag ? String(values.yearTag) : ''}
    inputmode="numeric"
    maxlength={4}
    error={fieldError(action, 'yearTag')}
  />
  <FormField
    id="{prefix}-description"
    name="description"
    label={i18n.t('mem.album.description')}
    value={values?.description ?? ''}
    maxlength={500}
    multiline
    error={fieldError(action, 'description')}
  />
{/snippet}

<PageHeader
  title={album?.name ?? i18n.t('mem.title')}
  lede={album?.description ?? i18n.t('mem.lede')}
>
  {#snippet actions()}
    {#if data.canUpload}
      <Button variant="primary" aria-haspopup="dialog" onclick={() => (uploading = true)}
        >{i18n.t('mem.add')}</Button
      >
    {/if}
  {/snippet}
</PageHeader>

<UploadSheet open={uploading} {albums} {albumsPager} onclose={() => (uploading = false)} />

<div class="stack">
  {#if failure}
    <Banner tone="danger">{failure}</Banner>
  {:else if saved}
    <Banner>{i18n.t('mem.album.saved')}</Banner>
  {/if}

  <nav class="filters" aria-label={i18n.t('mem.filters')}>
    {#if data.years.length > 0}
      <div class="chips" data-sveltekit-replacestate>
        <span class="label" id="year-filter">{i18n.t('mem.yearChips')}</span>
        <ul aria-labelledby="year-filter">
          <li>
            <a
              class="chip"
              href="{resolve('/memories')}{wallQuery({ year: null })}"
              aria-current={data.filter.year === null ? 'true' : undefined}
              >{i18n.t('mem.allYears')}</a
            >
          </li>
          {#each data.years as year (year)}
            <li>
              <a
                class="chip tnum"
                href="{resolve('/memories')}{wallQuery({ year })}"
                aria-current={data.filter.year === year ? 'true' : undefined}>{year}</a
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if albums.length > 0}
      <div class="chips" data-sveltekit-replacestate>
        <span class="label" id="album-filter">{i18n.t('mem.albums')}</span>
        <ul aria-labelledby="album-filter">
          <li>
            <a
              class="chip"
              href="{resolve('/memories')}{wallQuery({ album: null })}"
              aria-current={data.filter.album === null ? 'true' : undefined}
              >{i18n.t('mem.allAlbums')}</a
            >
          </li>
          {#each albums as entry (entry.id)}
            <li>
              <a
                class="chip"
                data-more-item={entry.id}
                href="{resolve('/memories')}{wallQuery({ album: entry.id })}"
                aria-current={data.filter.album === entry.id ? 'true' : undefined}>{entry.name}</a
              >
            </li>
          {/each}
          {#if albumsPager.cursor || albumsPager.loadedMore || albumsPager.error}
            <li>
              <LoadMore
                pager={albumsPager}
                variant="chip"
                href={(cursor) => `${resolve('/memories')}${wallQuery({ albumsCursor: cursor })}`}
              />
            </li>
          {/if}
        </ul>
      </div>
    {/if}
  </nav>

  <!-- R-MEM-14: albums are made and edited here; <details> needs no script. -->
  <div class="manage">
    <details class="task" open={form?.action === 'createAlbum' || undefined}>
      <summary>{i18n.t('mem.album.new')}</summary>
      <form method="POST" action="?/createAlbum" class="album-form" use:enhance>
        {@render albumFields('createAlbum', 'new-album')}
        <Button type="submit" variant="primary">{i18n.t('mem.album.create')}</Button>
      </form>
    </details>
    {#if album?.canEdit}
      <details class="task" open={form?.action === 'editAlbum' || undefined}>
        <summary>{i18n.t('mem.album.edit')}</summary>
        <form method="POST" action="?/editAlbum" class="album-form" use:enhance>
          <input type="hidden" name="id" value={album.id} />
          {@render albumFields('editAlbum', 'edit-album', album)}
          <p class="hint">{i18n.t('mem.album.yearRewrite')}</p>
          <Button type="submit" variant="primary">{i18n.t('mem.album.save')}</Button>
        </form>
      </details>
    {/if}
  </div>

  {#if data.photos.length === 0}
    <EmptyState
      title={i18n.t(data.filter.album || data.filter.year ? 'mem.emptyFiltered' : 'mem.empty')}
      body={i18n.t('mem.emptyBody')}
    />
  {:else}
    <ul class="wall">
      {#each data.photos as photo (photo.id)}
        <li>
          <a class="photo" href={resolve(`/memories/${photo.id}`)}>
            <img
              src="/api/v1/media/{photo.id}/thumb"
              alt={photo.caption ?? i18n.t('mem.photoBy', { name: photo.uploader.displayName })}
              width={photo.width}
              height={photo.height}
              loading="lazy"
              decoding="async"
            />
            <span class="cap">
              {#if photo.caption}<b>{photo.caption}</b>{/if}
              <small>
                {photo.uploader.displayName}{#if photo.year}<span class="year tnum"
                    >{photo.year}</span
                  >{/if}
              </small>
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if data.nextCursor || data.filter.paged}
    <nav class="pager" aria-label={i18n.t('mem.pages')}>
      {#if data.filter.paged}
        <a
          class="page-link"
          data-sveltekit-replacestate
          href="{resolve('/memories')}{wallQuery({})}">{i18n.t('mem.newest')}</a
        >
      {/if}
      {#if data.nextCursor}
        <a
          class="page-link next"
          data-sveltekit-replacestate
          href="{resolve('/memories')}{wallQuery({ cursor: data.nextCursor })}"
          >{i18n.t('mem.older')}</a
        >
      {/if}
    </nav>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: calc(var(--space-unit) * 5);
    min-width: 0;
  }

  .filters {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    min-width: 0;
  }

  .chips {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 3);
    min-width: 0;
  }

  .label {
    flex: none;
    color: var(--color-muted);
    font: var(--text-small);
    font-weight: 600;
  }

  .chips ul {
    display: flex;
    gap: calc(var(--space-unit) * 2);
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    min-width: 44px;
    padding: 0 calc(var(--space-unit) * 3.5);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text);
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }

  .chip[aria-current='true'] {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .manage {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: calc(var(--space-unit) * 3);
  }

  .task {
    min-width: 0;
  }

  .task[open] {
    flex: 1 1 100%;
  }

  summary {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font-weight: 600;
    cursor: pointer;
  }

  .album-form {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    justify-items: start;
    max-width: 32rem;
    margin-top: calc(var(--space-unit) * 3);
  }

  .album-form :global(.field) {
    justify-self: stretch;
  }

  .hint {
    margin: 0;
    color: var(--color-muted);
    font: var(--text-small);
  }

  .wall {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: calc(var(--space-unit) * 3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  @media (min-width: 768px) {
    .wall {
      grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
      gap: calc(var(--space-unit) * 4);
    }
  }

  .photo {
    display: grid;
    gap: calc(var(--space-unit) * 2);
    color: var(--color-text);
    text-decoration: none;
  }

  img {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: var(--radius-control);
    background: var(--color-surface-2);
  }

  .cap {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  b {
    overflow: hidden;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    overflow: hidden;
    color: var(--color-muted);
    font-size: 0.8125rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .year::before {
    content: ' · ';
    white-space: pre;
  }

  .pager {
    display: flex;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
  }

  .page-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    color: var(--color-text);
    font-weight: 600;
    text-decoration: none;
  }

  .page-link.next {
    margin-left: auto;
  }
</style>
