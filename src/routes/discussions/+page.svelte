<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import PostCard from '$lib/components/PostCard.svelte';
  import { POST_BODY_MAX, POST_TITLE_MAX } from '$lib/contracts/discussions';
  import { pluralKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import { shortTime } from '$lib/shared/time';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const i18n = useI18n();

  const failed = $derived(form?.action === 'create');
  const fields = $derived(form && 'fields' in form ? (form.fields as Record<string, string>) : {});
  const values = $derived(form && 'values' in form ? form.values : { title: '', body: '' });
  const message = $derived(
    failed && form && 'message' in form && !fields.title && !fields.body ? form.message : null,
  );
</script>

{#snippet compose()}
  <summary>{i18n.t('brd.write')}</summary>
  <Card class="compose-card">
    <form method="POST" action="?/create" use:enhance>
      {#if message}<Banner tone="danger">{message}</Banner>{/if}
      <FormField
        id="thread-title"
        name="title"
        label={i18n.t('brd.form.title')}
        value={values.title}
        maxlength={POST_TITLE_MAX}
        required
        error={fields.title ? i18n.t('brd.error.title') : undefined}
      />
      <FormField
        id="thread-body"
        name="body"
        label={i18n.t('brd.form.body')}
        hint={i18n.t('brd.form.hint')}
        value={values.body}
        maxlength={POST_BODY_MAX}
        multiline
        required
        error={fields.body ? i18n.t('brd.error.body') : undefined}
      />
      <Button type="submit" variant="primary">{i18n.t('brd.form.submit')}</Button>
    </form>
  </Card>
{/snippet}

<PageHeader title={i18n.t('brd.title')} lede={i18n.t('brd.lede')} />

<div class="board">
  {#if data.canCreate}
    <!-- R-AUTH-17: a plain form inside <details>, so it works without JavaScript. `open` is
         in the markup, never set by script: hydration can't close a panel opened early. -->
    {#if failed}
      <details class="compose" open>{@render compose()}</details>
    {:else}
      <details class="compose">{@render compose()}</details>
    {/if}
  {/if}

  {#if data.threads.length === 0}
    <EmptyState title={i18n.t('brd.empty')} body={i18n.t('brd.emptyBody')} />
  {:else}
    <Card class="threads">
      {#each data.threads as post (post.id)}
        <PostCard
          title={post.title}
          meta={[
            post.author.displayName,
            i18n.t(pluralKey(i18n.locale, 'brd.replies', post.commentCount), {
              count: post.commentCount,
            }),
            ...(post.isLocked ? [i18n.t('brd.locked')] : []),
          ].join(' · ')}
          time={shortTime(post.lastActivityAt, i18n.locale, data.timeZone)}
          href={`/discussions/${post.id}`}
          pinned={post.isPinned}
          pinnedLabel={i18n.t('brd.pinned')}
        />
      {/each}
    </Card>
  {/if}

  {#if data.nextCursor || data.paged}
    <nav class="pager" aria-label={i18n.t('brd.pages')}>
      {#if data.paged}
        <a class="page-link" href={resolve('/discussions')}>{i18n.t('brd.newest')}</a>
      {/if}
      {#if data.nextCursor}
        <a
          class="page-link next"
          data-sveltekit-replacestate
          href="{resolve('/discussions')}?cursor={encodeURIComponent(data.nextCursor)}"
          >{i18n.t('brd.older')}</a
        >
      {/if}
    </nav>
  {/if}
</div>

<style>
  .board {
    display: grid;
    gap: calc(var(--space-unit) * 5);
    max-width: 56rem;
    min-width: 0;
  }

  summary {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 5);
    border-radius: var(--radius-control);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    font-weight: 600;
    cursor: pointer;
  }

  .compose :global(.compose-card) {
    margin-top: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 5);
  }

  form {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    justify-items: start;
  }

  form :global(.field),
  form :global(.banner) {
    justify-self: stretch;
  }

  .pager {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
  }

  .page-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }

  .next {
    margin-left: auto;
  }
</style>
