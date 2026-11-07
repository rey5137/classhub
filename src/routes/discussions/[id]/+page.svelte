<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import { goBack } from '$lib/client/backstack';
  import Avatar from '$lib/components/Avatar.svelte';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import MarkdownBody from '$lib/components/MarkdownBody.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { COMMENT_MAX, POST_BODY_MAX, POST_TITLE_MAX } from '$lib/contracts/discussions';
  import { useI18n } from '$lib/i18n/context';
  import { fullTime } from '$lib/shared/time';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const i18n = useI18n();
  const post = $derived(data.post);

  // Without JavaScript the action's response is the page at the action URL: keep the comment
  // page's cursor in it so a failed or done action re-renders the page it came from.
  const action = (name: string) =>
    data.cursor ? `?cursor=${encodeURIComponent(data.cursor)}&/${name}` : `?/${name}`;

  const done = $derived(form && 'done' in form ? form.done : null);
  const doneMessage: Record<string, string> = {
    saved: 'thread.saved',
    pinned: 'thread.pinned',
    unpinned: 'thread.unpinned',
    locked: 'thread.lockedDone',
    unlocked: 'thread.unlockedDone',
    commentSaved: 'thread.commentSaved',
    commentDeleted: 'thread.commentRemoved',
  };
  const fields = $derived(form && 'fields' in form ? (form.fields as Record<string, string>) : {});
  const values = $derived(
    form && 'values' in form
      ? (form.values as Record<string, string>)
      : ({} as Record<string, string>),
  );
  const target = $derived(form && 'target' in form ? form.target : null);
  /** A refusal with no field to point at (forbidden, locked, rate limited) shows as a banner. */
  const failure = $derived(
    form && 'message' in form && Object.keys(fields).length === 0 ? form.message : null,
  );
  const failedOn = (action: string, row?: string) =>
    form?.action === action && !done && (row === undefined || target === row);
</script>

{#snippet byline(
  author: { displayName: string; avatarMediaId?: string },
  at: number,
  edited: boolean,
)}
  <div class="byline">
    <Avatar name={author.displayName} mediaId={author.avatarMediaId} size="sm" />
    <span class="who">{author.displayName}</span>
    <time class="tnum" datetime={new Date(at).toISOString()}
      >{fullTime(at, i18n.locale, data.timeZone)}</time
    >
    {#if edited}<em class="edited">{i18n.t('thread.edited')}</em>{/if}
  </div>
{/snippet}

<!-- `open` is in the markup, never set by script: hydration can't close a panel opened early. -->
{#snippet editPostForm()}
  <summary>{i18n.t('thread.edit')}</summary>
  <form method="POST" action={action('editPost')} class="confirm" use:enhance>
    <FormField
      id="edit-title"
      name="title"
      label={i18n.t('brd.form.title')}
      value={failedOn('editPost') ? values.title : post.title}
      maxlength={POST_TITLE_MAX}
      required
      error={failedOn('editPost') && fields.title ? i18n.t('brd.error.title') : undefined}
    />
    <FormField
      id="edit-body"
      name="body"
      label={i18n.t('brd.form.body')}
      hint={i18n.t('brd.form.hint')}
      value={failedOn('editPost') ? values.body : post.bodyMd}
      maxlength={POST_BODY_MAX}
      multiline
      required
      error={failedOn('editPost') && fields.body ? i18n.t('brd.error.body') : undefined}
    />
    <Button type="submit" variant="primary">{i18n.t('thread.save')}</Button>
  </form>
{/snippet}

{#snippet editCommentForm(comment: { id: string; bodyMd: string })}
  <summary>{i18n.t('thread.commentEdit')}</summary>
  <form method="POST" action={action('editComment')} class="confirm" use:enhance>
    <input type="hidden" name="commentId" value={comment.id} />
    <FormField
      id="edit-comment-{comment.id}"
      name="body"
      label={i18n.t('thread.commentEditLabel')}
      value={failedOn('editComment', comment.id) ? values.body : comment.bodyMd}
      maxlength={COMMENT_MAX}
      multiline
      required
      error={failedOn('editComment', comment.id) && fields.body
        ? i18n.t('thread.error.body')
        : undefined}
    />
    <Button type="submit" variant="primary">{i18n.t('thread.save')}</Button>
  </form>
{/snippet}

<PageHeader title={post.title}>
  {#snippet actions()}
    <a
      class="link"
      href={resolve('/discussions')}
      onclick={(event) => goBack(event, '/discussions')}>{i18n.t('thread.back')}</a
    >
  {/snippet}
</PageHeader>

<div class="thread">
  {#if failure}
    <Banner tone="danger">{failure}</Banner>
  {:else if done && doneMessage[done]}
    <Banner>{i18n.t(doneMessage[done] as 'thread.saved')}</Banner>
  {/if}

  <Card class="post">
    <article>
      {#if post.isPinned || post.isLocked}
        <p class="tags">
          {#if post.isPinned}<span class="pin">{i18n.t('brd.pinned')}</span>{/if}
          {#if post.isLocked}<span>{i18n.t('brd.locked')}</span>{/if}
        </p>
      {/if}
      {@render byline(post.author, post.createdAt, post.edited)}
      <MarkdownBody html={post.bodyHtml} />
    </article>
  </Card>

  {#if post.canEdit || post.canDelete || post.canModerate}
    <div class="tasks">
      {#if post.canModerate}
        <form method="POST" action={action('pin')} use:enhance>
          <input type="hidden" name="value" value={post.isPinned ? 'false' : 'true'} />
          <Button type="submit">{i18n.t(post.isPinned ? 'thread.unpin' : 'thread.pin')}</Button>
        </form>
        <form method="POST" action={action('lock')} use:enhance>
          <input type="hidden" name="value" value={post.isLocked ? 'false' : 'true'} />
          <Button type="submit">{i18n.t(post.isLocked ? 'thread.unlock' : 'thread.lock')}</Button>
        </form>
      {/if}
      {#if post.canEdit}
        <!-- R-BRD-08: edit and delete need no script; <details> holds each form. -->
        {#if failedOn('editPost')}
          <details class="task" open>{@render editPostForm()}</details>
        {:else}
          <details class="task">{@render editPostForm()}</details>
        {/if}
      {/if}
      {#if post.canDelete}
        <details class="task">
          <summary>{i18n.t('thread.delete')}</summary>
          <form method="POST" action={action('deletePost')} class="confirm" use:enhance>
            <p class="muted">{i18n.t('thread.deleteHint')}</p>
            <Button type="submit" variant="primary">{i18n.t('thread.deleteConfirm')}</Button>
          </form>
        </details>
      {/if}
    </div>
  {/if}

  <section class="comments" aria-labelledby="comments-head">
    <h2 id="comments-head">
      {i18n.t('thread.comments')} <small class="tnum">{post.commentCount}</small>
    </h2>

    {#if data.paged}
      <a class="link" href={resolve('/discussions/[id]', { id: post.id })}
        >{i18n.t('thread.first')}</a
      >
    {/if}

    {#if data.comments.length === 0}
      <p class="muted">{i18n.t('thread.noComments')}</p>
    {:else}
      <ol class="list">
        {#each data.comments as comment (comment.id)}
          <li id="comment-{comment.id}" class="comment" class:deleted={comment.deleted}>
            {#if comment.deleted}
              <!-- R-BRD-08: a deleted comment keeps its place when others follow it. -->
              <em class="muted">{i18n.t('brd.commentDeleted')}</em>
            {:else}
              {@render byline(comment.author, comment.createdAt, comment.edited)}
              <MarkdownBody html={comment.bodyHtml} />
              {#if comment.canEdit || comment.canDelete}
                <div class="comment-tasks">
                  {#if comment.canEdit}
                    {#if failedOn('editComment', comment.id)}
                      <details open>{@render editCommentForm(comment)}</details>
                    {:else}
                      <details>{@render editCommentForm(comment)}</details>
                    {/if}
                  {/if}
                  {#if comment.canDelete}
                    <details>
                      <summary>{i18n.t('thread.commentDelete')}</summary>
                      <form
                        method="POST"
                        action={action('deleteComment')}
                        class="confirm"
                        use:enhance
                      >
                        <input type="hidden" name="commentId" value={comment.id} />
                        <p class="muted">{i18n.t('thread.commentDeleteHint')}</p>
                        <Button type="submit" variant="primary"
                          >{i18n.t('thread.commentDeleteConfirm')}</Button
                        >
                      </form>
                    </details>
                  {/if}
                </div>
              {/if}
            {/if}
          </li>
        {/each}
      </ol>
    {/if}

    {#if data.nextCursor}
      <nav class="pager" data-sveltekit-replacestate aria-label={i18n.t('thread.pages')}>
        <a
          class="link"
          href="{resolve('/discussions/[id]', { id: post.id })}?cursor={encodeURIComponent(
            data.nextCursor,
          )}">{i18n.t('thread.newer')}</a
        >
      </nav>
    {/if}

    {#if data.canComment}
      <form method="POST" action={action('comment')} class="reply" use:enhance>
        <FormField
          id="comment-body"
          name="body"
          label={i18n.t('thread.commentLabel')}
          hint={i18n.t('brd.form.hint')}
          value={failedOn('comment') ? values.body : ''}
          maxlength={COMMENT_MAX}
          multiline
          required
          error={failedOn('comment') && fields.body ? i18n.t('thread.error.body') : undefined}
        />
        <Button type="submit" variant="primary">{i18n.t('thread.send')}</Button>
      </form>
    {:else if post.isLocked}
      <!-- R-BRD-07: a locked thread says so instead of offering the form, admins included. -->
      <Banner tone="warning">{i18n.t('brd.threadLocked')}</Banner>
    {/if}
  </section>
</div>

<style>
  .thread {
    display: grid;
    gap: calc(var(--space-unit) * 5);
    max-width: 50rem;
    min-width: 0;
  }

  .thread :global(.post) {
    padding: calc(var(--space-unit) * 5);
  }

  article {
    display: grid;
    gap: calc(var(--space-unit) * 3);
  }

  .tags {
    display: flex;
    gap: calc(var(--space-unit) * 3);
    margin: 0;
    color: var(--color-muted);
    font-size: 0.8125rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  .pin {
    color: var(--color-accent);
  }

  .byline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: calc(var(--space-unit) * 2);
    font-size: 0.875rem;
  }

  .who {
    font-weight: 600;
  }

  time,
  .edited {
    color: var(--color-muted);
  }

  .link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }

  .tasks {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: calc(var(--space-unit) * 3);
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

  .task[open] {
    flex-basis: 100%;
  }

  .confirm {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    justify-items: start;
    max-width: 40rem;
    margin-top: calc(var(--space-unit) * 3);
  }

  .confirm :global(.field) {
    justify-self: stretch;
  }

  .comments {
    display: grid;
    gap: calc(var(--space-unit) * 4);
  }

  h2 {
    font: var(--text-title);
    color: var(--color-heading);
  }

  h2 small {
    margin-left: calc(var(--space-unit) * 2);
    color: var(--color-muted);
    font: var(--text-small);
  }

  .list {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--color-divider);
    border-radius: var(--radius-card);
    background: var(--color-surface);
  }

  .comment {
    display: grid;
    gap: calc(var(--space-unit) * 2);
    padding: calc(var(--space-unit) * 4 * var(--density))
      calc(var(--space-unit) * 5 * var(--density));
    border-top: 1px solid var(--color-divider);
    scroll-margin-top: calc(var(--space-unit) * 20);
  }

  .comment:first-child {
    border-top: 0;
  }

  .comment:target {
    background: var(--color-surface-2);
  }

  .comment-tasks {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2);
  }

  .comment-tasks summary {
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 3);
    font-size: 0.875rem;
  }

  .comment-tasks details[open] {
    flex-basis: 100%;
  }

  .reply {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    justify-items: start;
  }

  .reply :global(.field) {
    justify-self: stretch;
  }

  .muted {
    margin: 0;
    color: var(--color-muted);
  }
</style>
