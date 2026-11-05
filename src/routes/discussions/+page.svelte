<script lang="ts">
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PostCard from '$lib/components/PostCard.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();

  const threads = $derived([
    {
      title: i18n.t('demo.copy45'),
      meta: i18n.t('demo.copy46'),
      time: i18n.t('demo.copy47'),
      pinned: true,
    },
    {
      title: i18n.t('demo.copy13'),
      meta: i18n.t('demo.copy14'),
      time: i18n.t('demo.copy15'),
      isNew: true,
    },
    { title: i18n.t('demo.copy16'), meta: i18n.t('demo.copy17'), time: i18n.t('demo.copy18') },
    { title: i18n.t('demo.copy19'), meta: i18n.t('demo.copy20'), time: i18n.t('demo.copy21') },
    {
      title: i18n.t('demo.copy48'),
      meta: i18n.t('demo.copy49'),
      time: i18n.t('demo.copy50'),
    },
    { title: i18n.t('demo.copy51'), meta: i18n.t('demo.copy52'), time: i18n.t('demo.copy53') },
  ]);
</script>

<PageHeader title={i18n.t('brd.title')} lede={i18n.t('brd.lede')}>
  {#snippet actions()}
    <Button variant="primary">{i18n.t('brd.write')}</Button>
  {/snippet}
</PageHeader>

<Card>
  {#each threads as thread (thread.title)}
    <PostCard
      title={thread.title}
      meta={thread.meta}
      time={thread.time}
      href="/discussions/thread"
      pinned={thread.pinned}
      isNew={thread.isNew}
      pinnedLabel={i18n.t('brd.pinned')}
      newLabel={i18n.t('brd.new')}
    />
  {/each}
</Card>
