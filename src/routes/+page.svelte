<script lang="ts">
  import { resolve } from '$app/paths';
  import Card from '$lib/components/Card.svelte';
  import MarkdownBody from '$lib/components/MarkdownBody.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PostCard from '$lib/components/PostCard.svelte';
  import Rail from '$lib/components/Rail.svelte';
  import Row from '$lib/components/Row.svelte';
  import Tile from '$lib/components/Tile.svelte';
  import { pluralKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import { shortTime } from '$lib/shared/time';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const i18n = useI18n();

  const replies = (count: number) =>
    i18n.t(pluralKey(i18n.locale, 'brd.replies', count), { count });
  const threadMeta = (post: { author: { displayName: string }; commentCount: number }) =>
    `${post.author.displayName} · ${replies(post.commentCount)}`;
</script>

<!-- R-BRD-01: welcome, pinned, reunion, newest photos, active threads, in that order. -->
<div class="head">
  <div class="welcome">
    <PageHeader
      title={i18n.t('home.greeting', { name: data.greeting })}
      lede={`${data.site.name} · ${data.site.years}`}
    />
    {#if data.welcome.bannerMediaId}
      <img class="banner" src="/api/v1/media/{data.welcome.bannerMediaId}/image" alt="" />
    {/if}
    {#if data.welcome.html}
      <div class="welcome-body"><MarkdownBody html={data.welcome.html} /></div>
    {/if}
  </div>

  <section class="pinned" aria-labelledby="home-pinned">
    <h2 id="home-pinned">{i18n.t('home.pinned')}</h2>
    {#if data.pinnedInfo.length || data.threads?.pinned.length}
      <Card>
        {#each data.pinnedInfo as info (info.slug)}
          <a class="info-link" href={resolve('/info/[slug]', { slug: info.slug })}>{info.title}</a>
        {/each}
        {#each data.threads?.pinned ?? [] as post (post.id)}
          <PostCard
            title={post.title}
            meta={threadMeta(post)}
            time={shortTime(post.lastActivityAt, i18n.locale, data.timeZone)}
            href={`/discussions/${post.id}`}
            pinned
            pinnedLabel={i18n.t('brd.pinned')}
          />
        {/each}
      </Card>
    {:else}
      <p class="empty">{i18n.t('home.pinnedEmpty')}</p>
    {/if}
  </section>

  {#if data.reunion}
    <Card class="reunion">
      <h2>{data.reunion.title}</h2>
      {#if data.reunion.bodyHtml}<MarkdownBody html={data.reunion.bodyHtml} />{/if}
      <a class="more" href={resolve('/info/[slug]', { slug: 'reunion' })}
        >{i18n.t('home.reunionMore')}</a
      >
    </Card>
  {/if}
</div>

<div class="wall">
  {#if data.photos}
    <Row title={i18n.t('home.newPhotos')} href="/memories" linkLabel={i18n.t('home.viewAll')}>
      {#if data.photos.length}
        <Rail label={i18n.t('home.newPhotos')}>
          {#each data.photos as photo, index (photo.id)}
            <Tile
              title={photo.caption ?? i18n.t('mem.photoBy', { name: photo.uploader.displayName })}
              meta={photo.uploader.displayName}
              href={`/memories/${photo.id}`}
              image="/api/v1/media/{photo.id}/thumb"
              grow={index === 0}
            />
          {/each}
        </Rail>
      {:else}
        <p class="empty">{i18n.t('home.photosEmpty')}</p>
      {/if}
    </Row>
  {/if}

  {#if data.threads}
    <Row
      title={i18n.t('home.discussing')}
      href="/discussions"
      linkLabel={i18n.t('home.discussions')}
    >
      {#if data.threads.active.length}
        <Card class="active">
          {#each data.threads.active as post (post.id)}
            <PostCard
              title={post.title}
              meta={threadMeta(post)}
              time={shortTime(post.lastActivityAt, i18n.locale, data.timeZone)}
              href={`/discussions/${post.id}`}
            />
          {/each}
        </Card>
      {:else}
        <p class="empty">{i18n.t('home.threadsEmpty')}</p>
      {/if}
    </Row>
  {/if}
</div>

<style>
  .head {
    display: grid;
    gap: calc(var(--space-unit) * 6);
    margin-bottom: calc(var(--space-unit) * 8);
  }

  @media (min-width: 1024px) {
    .head {
      grid-template-columns: minmax(0, 1fr) 27.5rem;
      grid-template-rows: auto 1fr;
      align-items: start;
    }

    /* The reunion sits beside the title on desktop (§6), the pinned list under it. */
    .welcome,
    .pinned {
      grid-column: 1;
    }

    .head :global(.reunion) {
      grid-column: 2;
      grid-row: 1 / span 2;
    }

    .head :global(.page-header) {
      margin-bottom: calc(var(--space-unit) * 4);
    }
  }

  .welcome {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    min-width: 0;
  }

  .welcome :global(.page-header) {
    margin-bottom: 0;
  }

  .banner {
    display: block;
    width: 100%;
    max-height: 18rem;
    object-fit: cover;
    border-radius: var(--radius-card);
    background: var(--color-surface-2);
  }

  .welcome-body {
    max-width: 46rem;
  }

  .pinned {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    min-width: 0;
  }

  h2 {
    font: var(--text-title);
    color: var(--color-heading);
  }

  .info-link {
    display: flex;
    align-items: center;
    min-height: 44px;
    padding: calc(var(--space-unit) * 2 * var(--density))
      calc(var(--space-unit) * 5 * var(--density));
    border-bottom: 1px solid var(--color-divider);
    font-weight: 600;
  }

  .info-link:hover {
    color: var(--color-accent);
  }

  .info-link:last-child {
    border-bottom: 0;
  }

  .info-link + :global(.post) {
    border-top: 0;
  }

  .head :global(.reunion) {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 4.5) calc(var(--space-unit) * 5);
    min-width: 0;
  }

  .head :global(.reunion h2) {
    font: var(--text-heading);
  }

  .more {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }

  .wall {
    display: grid;
    gap: calc(var(--space-unit) * 8);
  }

  .empty {
    color: var(--color-muted);
  }
</style>
