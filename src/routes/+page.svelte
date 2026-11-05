<script lang="ts">
  import Avatar from '$lib/components/Avatar.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PostCard from '$lib/components/PostCard.svelte';
  import Rail from '$lib/components/Rail.svelte';
  import Row from '$lib/components/Row.svelte';
  import Tile from '$lib/components/Tile.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();

  const photos = $derived([
    { title: i18n.t('demo.copy1'), meta: i18n.t('demo.copy2') },
    { title: i18n.t('demo.copy3'), meta: i18n.t('demo.copy4') },
    { title: i18n.t('demo.copy5'), meta: i18n.t('demo.copy6') },
    { title: i18n.t('demo.copy7'), meta: i18n.t('demo.copy8') },
    { title: i18n.t('demo.copy9'), meta: i18n.t('demo.copy10') },
    { title: i18n.t('demo.copy11'), meta: i18n.t('demo.copy12') },
  ]);

  const posts = $derived([
    {
      title: i18n.t('demo.copy13'),
      meta: i18n.t('demo.copy14'),
      time: i18n.t('demo.copy15'),
      isNew: true,
    },
    { title: i18n.t('demo.copy16'), meta: i18n.t('demo.copy17'), time: i18n.t('demo.copy18') },
    { title: i18n.t('demo.copy19'), meta: i18n.t('demo.copy20'), time: i18n.t('demo.copy21') },
  ]);

  const people = $derived([
    { name: i18n.t('demo.copy22'), city: i18n.t('demo.copy23') },
    { name: i18n.t('demo.copy4'), city: i18n.t('demo.copy24') },
    { name: i18n.t('demo.copy6'), city: i18n.t('demo.copy25') },
    { name: i18n.t('demo.copy8'), city: i18n.t('demo.copy26') },
    { name: i18n.t('demo.copy10'), city: i18n.t('demo.copy23') },
  ]);

  const years = $derived([
    { title: i18n.t('demo.copy27'), meta: i18n.t('demo.copy28') },
    { title: i18n.t('demo.copy29'), meta: i18n.t('demo.copy30') },
    { title: i18n.t('demo.copy5'), meta: i18n.t('demo.copy31') },
    { title: i18n.t('demo.copy32'), meta: i18n.t('demo.copy33') },
    { title: i18n.t('demo.copy34'), meta: i18n.t('demo.copy35') },
  ]);
</script>

<div class="head">
  <PageHeader title={i18n.t('home.title')} lede={i18n.t('home.lede')} />
  <Card class="reunion">
    <h2>{i18n.t('home.reunion.title')}</h2>
    <p class="tnum muted">{i18n.t('home.reunion.meta')}</p>
    <div class="who">
      {#each people.slice(0, 4) as person, index (person.name)}
        <Avatar name={person.name} size="sm" tone={index} showInitials={false} />
      {/each}
      <span>{i18n.t('home.reunion.who')}</span>
    </div>
    <div class="acts">
      <Button variant="primary">{i18n.t('home.reunion.going')}</Button>
      <Button>{i18n.t('home.reunion.maybe')}</Button>
    </div>
  </Card>
</div>

<div class="wall">
  <Row title={i18n.t('home.newPhotos')} href="/memories" linkLabel={i18n.t('home.viewAll')}>
    <Rail label={i18n.t('home.newPhotos')}>
      {#each photos as photo, index (photo.title)}
        <Tile
          title={photo.title}
          meta={photo.meta}
          tone={index + 5}
          isNew={index === 0}
          grow={index === 0}
        />
      {/each}
    </Rail>
  </Row>

  <div class="two">
    <Row
      title={i18n.t('home.discussing')}
      href="/discussions"
      linkLabel={i18n.t('home.discussions')}
    >
      <Card>
        {#each posts as post (post.title)}
          <PostCard
            title={post.title}
            meta={post.meta}
            time={post.time}
            isNew={post.isNew}
            newLabel={i18n.t('brd.new')}
          />
        {/each}
      </Card>
    </Row>

    <Row
      title={i18n.t('home.classmates')}
      meta={i18n.t('home.membersJoined', { joined: 32, total: 41 })}
      href="/members"
      linkLabel={i18n.t('home.members')}
    >
      <Rail label={i18n.t('home.classmates')}>
        {#each people as person, index (person.name)}
          <div class="person">
            <Avatar name={person.name} size="lg" tone={index} />
            <b>{person.name}</b>
            <small>{person.city}</small>
          </div>
        {/each}
      </Rail>
    </Row>
  </div>

  <Row
    title={i18n.t('home.yearHead', { year: 2006 })}
    meta={i18n.t('home.yearMeta')}
    href="/memories"
    linkLabel={i18n.t('home.album')}
  >
    <Rail label={i18n.t('home.yearHead', { year: 2006 })}>
      {#each years as year, index (year.title)}
        <Tile title={year.title} meta={year.meta} tone={index + 6} />
      {/each}
    </Rail>
  </Row>
</div>

<style>
  .head {
    margin-bottom: calc(var(--space-unit) * 8);
  }

  @media (min-width: 1024px) {
    .head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 27.5rem;
      align-items: start;
      gap: calc(var(--space-unit) * 6);
    }

    .head :global(.page-header) {
      margin-bottom: 0;
    }
  }

  .head :global(.reunion) {
    display: grid;
    gap: var(--space-unit);
    padding: calc(var(--space-unit) * 4.5) calc(var(--space-unit) * 5);
  }

  .head :global(.reunion h2) {
    font: var(--text-heading);
  }

  .muted {
    color: var(--color-muted);
    font-size: 0.9375rem;
  }

  .who {
    display: flex;
    align-items: center;
    margin-top: calc(var(--space-unit) * 2);
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .who :global(.avatar + .avatar) {
    margin-left: calc(var(--space-unit) * -2);
    border: 2px solid var(--color-surface);
  }

  .who > span {
    margin-left: calc(var(--space-unit) * 2.5);
  }

  .acts {
    display: flex;
    gap: calc(var(--space-unit) * 2);
    margin-top: calc(var(--space-unit) * 3);
  }

  .acts :global(.primary) {
    flex: 1;
  }

  @media (min-width: 768px) {
    .acts :global(.primary) {
      flex: none;
    }
  }

  .wall {
    display: grid;
    gap: calc(var(--space-unit) * 8);
  }

  .two {
    display: grid;
    gap: calc(var(--space-unit) * 8);
  }

  @media (min-width: 1024px) {
    .two {
      grid-template-columns: 1.4fr 1fr;
      align-items: start;
    }
  }

  .person {
    flex: none;
    width: 96px;
    text-align: center;
    font-size: 0.875rem;
    font-weight: 500;
  }

  @media (min-width: 768px) {
    .person {
      width: 120px;
    }
  }

  .person b {
    display: block;
    margin-top: calc(var(--space-unit) * 2);
  }

  .person small {
    display: block;
    color: var(--color-muted);
    font-size: 0.8125rem;
    font-weight: 400;
  }
</style>
