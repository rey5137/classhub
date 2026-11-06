<script lang="ts">
  import { enhance } from '$app/forms';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import type { JoinRequestView } from '$lib/contracts/join';
  import type { MessageKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';

  interface Props {
    queue: { enabled: boolean; items: JoinRequestView[]; full: boolean };
    formatDate: (at: number) => string;
  }

  // A failed approve or reject shows in the page's banner, like the invite list's actions.
  let { queue, formatDate }: Props = $props();
  const i18n = useI18n();

  const labelFor = (action: MessageKey, request: JoinRequestView) =>
    i18n.t('admin.actionFor', { action: i18n.t(action), name: request.name });
</script>

<!-- R-AUTH-30: who asked, what they wrote and when; approve runs the invite path. -->
<Card class="sheet" aria-labelledby="join-head">
  <div class="head">
    <h2 id="join-head">{i18n.t('admin.join.title')}</h2>
  </div>
  {#if !queue.enabled}
    <p class="muted">{i18n.t('admin.join.off')}</p>
  {:else if queue.full}
    <Banner tone="warning">{i18n.t('admin.join.full')}</Banner>
  {/if}
  {#if queue.items.length === 0}
    <p class="muted">{i18n.t('admin.join.empty')}</p>
  {:else}
    <ul class="requests">
      {#each queue.items as request (request.id)}
        <li class="request">
          <div class="who">
            <p class="name">{request.name}</p>
            <p class="email">{request.email}</p>
            {#if request.note}<p class="note">{request.note}</p>{/if}
            <p class="meta tnum">
              {i18n.t('admin.join.requested', { date: formatDate(request.createdAt) })}
            </p>
          </div>
          <div class="actions">
            <form method="POST" action="?/joinApprove" use:enhance>
              <input type="hidden" name="id" value={request.id} />
              <Button
                type="submit"
                variant="primary"
                aria-label={labelFor('admin.join.approve', request)}
                >{i18n.t('admin.join.approve')}</Button
              >
            </form>
            <form method="POST" action="?/joinReject" use:enhance>
              <input type="hidden" name="id" value={request.id} />
              <Button
                type="submit"
                variant="ghost"
                aria-label={labelFor('admin.join.reject', request)}
                >{i18n.t('admin.join.reject')}</Button
              >
            </form>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="hint">{i18n.t('admin.join.hint')}</p>
</Card>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 2);
  }

  h2 {
    font: var(--text-heading);
  }

  .muted,
  .hint,
  .meta {
    color: var(--color-muted);
  }

  .hint,
  .meta,
  .email {
    font: var(--text-small);
  }

  .requests {
    display: grid;
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .request {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 3) 0;
    border-top: 1px solid var(--color-divider);
  }

  .who {
    display: grid;
    gap: calc(var(--space-unit) * 0.5);
    min-width: 0;
    flex: 1 1 16rem;
  }

  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .email,
  .note {
    overflow-wrap: anywhere;
  }

  .note {
    white-space: pre-line;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2);
  }
</style>
