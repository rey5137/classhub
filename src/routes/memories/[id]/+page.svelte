<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import { goBack } from '$lib/client/backstack';
  import Avatar from '$lib/components/Avatar.svelte';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';
  import { mediumDate } from '$lib/shared/time';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const i18n = useI18n();

  const photo = $derived(data.photo);
  const byline = $derived(i18n.t('mem.photoBy', { name: photo.uploader.displayName }));
  const failure = $derived(form && 'message' in form ? form.message : null);
  const saved = $derived(form && 'done' in form && form.done === 'saved');
  // R-UI-11: in the viewer's time zone, the same as every other date on the page.
  const formatDate = (at: number | Date) => mediumDate(at, i18n.locale, data.timeZone);
</script>

<PageHeader title={photo.caption ?? byline} />

<div class="photo-page">
  {#if failure}
    <Banner tone="danger">{failure}</Banner>
  {:else if saved}
    <Banner>{i18n.t('photo.saved')}</Banner>
  {/if}

  <Card class="photo-card">
    <img
      src="/api/v1/media/{photo.id}/image"
      alt={photo.caption ?? byline}
      width={photo.width}
      height={photo.height}
    />
    <dl class="meta">
      <div class="who">
        <dt>{i18n.t('photo.uploader')}</dt>
        <dd>
          <Avatar
            name={photo.uploader.displayName}
            size="sm"
            mediaId={photo.uploader.avatarMediaId}
          />
          {photo.uploader.displayName}
        </dd>
      </div>
      <div>
        <dt>{i18n.t('photo.album')}</dt>
        <dd>
          {#if photo.album}
            <a href="{resolve('/memories')}?album={photo.album.id}">{photo.album.name}</a>
          {:else}
            {i18n.t('mem.upload.noAlbum')}
          {/if}
        </dd>
      </div>
      <div>
        <dt>{i18n.t('photo.year')}</dt>
        <dd class="tnum">
          {#if photo.year}
            <a href="{resolve('/memories')}?year={photo.year}">{photo.year}</a>
          {:else}
            {i18n.t('photo.noYear')}
          {/if}
        </dd>
      </div>
      <div>
        <dt>{i18n.t('photo.added')}</dt>
        <dd class="tnum">{formatDate(photo.createdAt)}</dd>
      </div>
    </dl>
  </Card>

  <div class="tasks">
    <a class="link" href={resolve('/memories')} onclick={(event) => goBack(event, '/memories')}
      >{i18n.t('photo.back')}</a
    >
    <a
      class="link"
      href={resolve('/api/v1/media/[id]/[variant]', { id: photo.id, variant: 'image' })}
      download>{i18n.t('photo.download')}</a
    >
  </div>

  {#if photo.canEdit}
    <details class="task" open={form?.action === 'edit' && !saved ? true : undefined}>
      <summary>{i18n.t('photo.edit')}</summary>
      <form method="POST" action="?/edit" class="confirm" use:enhance>
        <FormField
          id="photo-caption"
          name="caption"
          label={i18n.t('mem.upload.caption')}
          value={photo.caption ?? ''}
          maxlength={500}
          multiline
        />
        {#if data.albums.length > 0}
          <div class="field">
            <label for="photo-album">{i18n.t('mem.upload.album')}</label>
            <select id="photo-album" name="albumId">
              <option value="" selected={!photo.album}>{i18n.t('mem.upload.noAlbum')}</option>
              {#each data.albums as album (album.id)}
                <option value={album.id} selected={photo.album?.id === album.id}
                  >{album.name}</option
                >
              {/each}
            </select>
          </div>
        {/if}
        <Button type="submit" variant="primary">{i18n.t('photo.save')}</Button>
      </form>
    </details>
  {/if}
  {#if data.canDelete}
    <!-- R-MEM-20: deleting asks once more; <details> needs no script. -->
    <details class="task">
      <summary>{i18n.t('photo.delete')}</summary>
      <form method="POST" action="?/delete" class="confirm" use:enhance>
        <p class="muted">{i18n.t('photo.deleteHint')}</p>
        <Button type="submit" variant="primary">{i18n.t('photo.deleteConfirm')}</Button>
      </form>
    </details>
  {/if}
</div>

<style>
  .photo-page {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    max-width: 56rem;
    min-width: 0;
  }

  .photo-page :global(.photo-card) {
    overflow: hidden;
  }

  img {
    display: block;
    width: 100%;
    height: auto;
    max-height: 75vh;
    object-fit: contain;
    background: var(--color-surface-2);
  }

  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: calc(var(--space-unit) * 4);
    margin: 0;
    padding: calc(var(--space-unit) * 4) calc(var(--space-unit) * 5);
  }

  dt {
    color: var(--color-muted);
    font: var(--text-small);
  }

  dd {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 2);
    min-height: 32px;
    margin: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  dd a {
    color: var(--color-accent);
  }

  .tasks {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 4);
  }

  .link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }

  .task {
    padding-top: calc(var(--space-unit) * 4);
    border-top: 1px solid var(--color-divider);
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

  .confirm {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    justify-items: start;
    max-width: 32rem;
    margin-top: calc(var(--space-unit) * 3);
  }

  .confirm :global(.field) {
    justify-self: stretch;
  }

  .field {
    display: grid;
    gap: var(--space-unit);
  }

  .field label {
    font-weight: 600;
  }

  select {
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
  }

  .muted {
    margin: 0;
    color: var(--color-muted);
  }
</style>
