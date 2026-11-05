<script lang="ts">
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PostCard from '$lib/components/PostCard.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();
</script>

<PageHeader title={i18n.t('thread.title')} lede={i18n.t('thread.body')} />

<Card>
  <PostCard
    title={i18n.t('demo.copy13')}
    meta={i18n.t('demo.copy14')}
    time={i18n.t('demo.copy15')}
    isNew
    newLabel={i18n.t('brd.new')}
  />
</Card>

<div class="reply">
  <Card class="composer">
    <FormField
      id="reply"
      label={i18n.t('thread.reply')}
      multiline
      placeholder={i18n.t('chat.composer')}
    />
  </Card>
  <Button variant="primary">{i18n.t('thread.reply')}</Button>
</div>

<style>
  .reply {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    margin-top: calc(var(--space-unit) * 6);
  }

  .reply :global(.composer) {
    padding: calc(var(--space-unit) * 4);
  }
</style>
