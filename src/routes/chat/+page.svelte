<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import {
    bodyLength,
    ChatSession,
    fetchHistory,
    firstUnreadId,
    isSendable,
    LAST_READ_KEY,
    laterRead,
    linkify,
    socketUrl,
    type ChatSnapshot,
    type Outgoing,
  } from '$lib/client/chat';
  import { siteConfig } from '$lib/config';
  import { CHAT_BODY_MAX, type ChatMessage } from '$lib/contracts/chat';
  import { pluralKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import { fullTime, shortTime } from '$lib/shared/time';
  import type { PageProps } from './$types';

  // §9.3: the session (src/lib/client/chat.ts) owns the timeline and the socket; this
  // page renders its snapshot, keeps the scroll where the member expects it and keeps
  // the unread mark (R-CHAT-12).

  let { data }: PageProps = $props();
  const i18n = useI18n();

  /** The counter shows once a message gets this long. */
  const COUNTER_FROM = 900;
  const DELETE_TIMEOUT_MS = 15_000;

  let snap = $state<ChatSnapshot>({
    messages: [],
    outbox: [],
    status: 'loading',
    online: null,
    olderCursor: null,
    loadingOlder: false,
    live: null,
  });
  let session: ChatSession | undefined;
  let draft = $state('');
  let field = $state<HTMLTextAreaElement>();
  let end = $state<HTMLDivElement>();
  /** The end of the timeline is on screen: new messages keep it there and count as read. */
  let atBottom = true;
  let markerId = $state<string | null>(null);
  let markerSet = false;
  let confirming = $state<ChatMessage | null>(null);
  let deleteProblem = $state(false);

  const length = $derived(bodyLength(draft));
  const sendable = $derived(isSendable(draft));
  const canSend = $derived(snap.status === 'online' && sendable);
  /** Within 1,000 characters but past the 4 KB frame (escaped control characters, say). */
  const tooLarge = $derived(length > 0 && length <= CHAT_BODY_MAX && !sendable);
  const counted = $derived(length > COUNTER_FROM || tooLarge);
  /** What the announcer reads: only a message that arrived live from someone else. */
  const announcement = $derived(
    snap.live && !snap.live.deleted ? `${snap.live.sender.displayName}: ${snap.live.body}` : '',
  );
  const newestId = $derived(snap.messages.at(-1)?.id ?? null);

  function storedRead(): string | null {
    try {
      return localStorage.getItem(LAST_READ_KEY);
    } catch {
      return null;
    }
  }

  /** R-CHAT-12: only this browser keeps it; nothing about reading reaches the server. */
  function markRead() {
    if (!newestId || !atBottom || document.hidden) return;
    try {
      const stored = storedRead();
      const next = laterRead(stored, newestId);
      if (next !== stored) localStorage.setItem(LAST_READ_KEY, next);
    } catch {
      // Storage refused (private mode): the marker just never shows.
    }
  }

  // The page itself scrolls; its bottom padding keeps the newest clear of the composer.
  function scrollToEnd() {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }

  async function changed(next: ChatSnapshot) {
    const first = !markerSet && next.status !== 'loading';
    if (first) {
      markerSet = true;
      markerId = firstUnreadId(next.messages, storedRead(), data.viewerId);
    }
    snap = next;
    if (first) {
      await tick();
      scrollToEnd();
    }
  }

  onMount(() => {
    session = new ChatSession({
      history: fetchHistory,
      openSocket: () => new WebSocket(socketUrl(location)),
      onChange: (next) => void changed(next),
    });
    void session.start();
    // A tab opened in the background never fires visibilitychange until it is shown.
    session.visibility(document.hidden);
    const onVisibility = () => {
      session?.visibility(document.hidden);
      markRead();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      session?.stop();
    };
  });

  // The end sentinel tells whether the newest message is on screen.
  $effect(() => {
    if (!end) return;
    const observer = new IntersectionObserver(([entry]) => {
      atBottom = entry?.isIntersecting ?? false;
      markRead();
    });
    observer.observe(end);
    return () => observer.disconnect();
  });

  // A new message keeps the view at the end only when it was there (focus never moves).
  $effect(() => {
    void newestId;
    void snap.outbox.length;
    if (!atBottom) return;
    void tick().then(() => {
      scrollToEnd();
      markRead();
    });
  });

  async function loadOlder() {
    // R-CHAT-10: older messages go in above without moving what is on screen.
    const height = document.documentElement.scrollHeight;
    await session?.loadOlder();
    await tick();
    window.scrollBy(0, document.documentElement.scrollHeight - height);
  }

  function submit(event?: Event) {
    event?.preventDefault();
    if (!canSend || !session?.send(draft)) return;
    deleteProblem = false;
    draft = '';
    atBottom = true;
  }

  function onKeydown(event: KeyboardEvent) {
    // An IME (Vietnamese Telex, for one) confirms its word with Enter: that is not a send.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }
    submit(event);
  }

  async function confirmDelete() {
    const message = confirming;
    confirming = null;
    if (!message) return;
    const response = await fetch(`/api/v1/chat/messages/${encodeURIComponent(message.id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    }).catch(() => null);
    deleteProblem = !response?.ok;
    if (response?.ok) session?.deleted(message.id);
    // The button went with the message: give focus a stable place.
    field?.focus();
  }

  const own = (message: { sender: { id: string } }) => message.sender.id === data.viewerId;
  const timeOf = (at: number) => shortTime(at, i18n.locale, data.timeZone);

  function notSentText(item: Outgoing): string {
    if (item.code === 'rate_limited') return i18n.t('chat.notSentRateLimited');
    if (item.code === 'validation' || item.code === 'payload_too_large') {
      return i18n.t('chat.notSentInvalid', { max: CHAT_BODY_MAX });
    }
    return i18n.t('chat.notSent');
  }

  const statusText = $derived.by(() => {
    switch (snap.status) {
      case 'loading':
        return i18n.t('chat.loading');
      case 'connecting':
        return i18n.t('chat.connecting');
      case 'reconnecting':
        return i18n.t('chat.reconnecting');
      case 'paused':
        return i18n.t('chat.paused');
      case 'online':
        return snap.online === null
          ? ''
          : i18n.t(pluralKey(i18n.locale, 'chat.online', snap.online), { count: snap.online });
      default:
        return '';
    }
  });
</script>

<PageHeader
  title={i18n.t('chat.title')}
  lede={i18n.t('chat.lede', { days: siteConfig.chat.retainDays })}
/>

<div class="chat">
  {#if snap.olderCursor}
    <div class="older">
      <Button variant="ghost" onclick={loadOlder} disabled={snap.loadingOlder}>
        {snap.loadingOlder ? i18n.t('chat.loadingOlder') : i18n.t('chat.older')}
      </Button>
    </div>
  {:else if snap.status !== 'loading' && snap.messages.length > 0}
    <p class="edge">{i18n.t('chat.start')}</p>
  {/if}

  <!-- The log itself is silent: history pages, older pages and catch-ups would all be
       read out. The announcer below speaks only for live messages from others. -->
  <div class="log" role="log" aria-live="off" aria-label={i18n.t('chat.log')}>
    {#if snap.status !== 'loading' && snap.messages.length === 0 && snap.outbox.length === 0}
      <p class="edge">{i18n.t('chat.empty')}</p>
    {/if}
    {#each snap.messages as message (message.id)}
      {#if message.id === markerId}
        <div class="unread"><span>{i18n.t('chat.unread')}</span></div>
      {/if}
      <div
        class="msg"
        class:me={own(message)}
        class:gone={message.deleted}
        data-message-id={message.id}
      >
        <small class="meta">
          <span>{own(message) ? i18n.t('chat.you') : message.sender.displayName}</span>
          <span aria-hidden="true">·</span>
          <time
            datetime={new Date(message.createdAt).toISOString()}
            title={fullTime(message.createdAt, i18n.locale, data.timeZone)}
            >{timeOf(message.createdAt)}</time
          >
          {#if !message.deleted && (own(message) || data.deleteAny)}
            <button
              type="button"
              class="action"
              aria-label={own(message)
                ? i18n.t('chat.deleteLabel', { time: timeOf(message.createdAt) })
                : i18n.t('chat.deleteAnyLabel', {
                    name: message.sender.displayName,
                    time: timeOf(message.createdAt),
                  })}
              onclick={() => {
                deleteProblem = false;
                confirming = message;
              }}>{i18n.t('chat.delete')}</button
            >
          {/if}
        </small>
        {#if message.deleted}
          <p class="body">{i18n.t('chat.deleted')}</p>
        {:else}
          <p class="body">
            {#each linkify(message.body) as segment, index (index)}{#if 'href' in segment}<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an https: link in a message leaves the app (R-CHAT-01) --><a
                  href={segment.href}
                  target="_blank"
                  rel="noopener noreferrer nofollow">{segment.text}</a
                >{:else}{segment.text}{/if}{/each}
          </p>
        {/if}
      </div>
    {/each}
    {#each snap.outbox as item (item.clientNonce)}
      <div class="msg me" class:failed={item.state === 'failed'} data-outbox={item.state}>
        <small>
          {#if item.state === 'pending'}{i18n.t('chat.sending')}{:else}<strong
              >{notSentText(item)}</strong
            >{/if}
        </small>
        <p class="body">{item.body}</p>
        {#if item.state === 'failed'}
          <span class="actions">
            <button
              type="button"
              class="action"
              aria-label={i18n.t('chat.retryLabel')}
              disabled={snap.status !== 'online'}
              onclick={() => session?.retry(item.clientNonce)}>{i18n.t('chat.retry')}</button
            >
            <button
              type="button"
              class="action"
              aria-label={i18n.t('chat.discardLabel')}
              onclick={() => session?.discard(item.clientNonce)}>{i18n.t('chat.discard')}</button
            >
          </span>
        {/if}
      </div>
    {/each}
  </div>
  <div class="end" bind:this={end}></div>
  <p class="visually-hidden" aria-live="polite" data-announcer>{announcement}</p>
</div>

<div class="composer">
  <div class="composer-status">
    <p class="status" role="status" data-status={snap.status} data-online={snap.online}>
      {#if snap.status === 'online'}<span class="dot" aria-hidden="true"></span>{/if}{statusText}
    </p>

    {#if snap.status === 'reauth'}
      <Banner tone="warning">
        <p>{i18n.t('chat.reauth')}</p>
        <Button variant="primary" onclick={() => location.reload()}
          >{i18n.t('chat.reauthAction')}</Button
        >
      </Banner>
    {:else if snap.status === 'forbidden'}
      <Banner tone="warning">{i18n.t('chat.forbidden')}</Banner>
    {:else if snap.status === 'failed'}
      <Banner tone="danger">
        <p>{i18n.t('chat.loadFailed')}</p>
        <Button onclick={() => session?.start()}>{i18n.t('chat.tryAgain')}</Button>
      </Banner>
    {/if}
    {#if deleteProblem}
      <Banner tone="danger">{i18n.t('chat.deleteFailed')}</Banner>
    {/if}
  </div>
  {#if snap.status !== 'reauth' && snap.status !== 'forbidden'}
    <form class="compose" onsubmit={submit}>
      <div class="composer-inner">
        <label for="message" class="visually-hidden">{i18n.t('chat.composer')}</label>
        <textarea
          id="message"
          bind:this={field}
          bind:value={draft}
          rows="1"
          placeholder={i18n.t('chat.composer')}
          aria-describedby="message-hint{counted ? ' message-count' : ''}"
          aria-invalid={length > CHAT_BODY_MAX || tooLarge ? true : undefined}
          onkeydown={onKeydown}></textarea>
        <p id="message-hint" class="visually-hidden">{i18n.t('chat.hint')}</p>
        {#if counted}
          <p id="message-count" class="count" class:over={length > CHAT_BODY_MAX || tooLarge}>
            {tooLarge
              ? i18n.t('chat.tooLarge')
              : i18n.t('chat.counter', { count: length, max: CHAT_BODY_MAX })}
          </p>
        {/if}
        <Button variant="primary" type="submit" disabled={!canSend}>{i18n.t('chat.send')}</Button>
      </div>
    </form>
  {/if}
</div>

<Dialog
  open={confirming !== null}
  title={i18n.t('chat.deleteConfirm')}
  onclose={() => (confirming = null)}
>
  <div class="dialog-actions">
    <Button onclick={() => (confirming = null)}>{i18n.t('chat.cancel')}</Button>
    <Button variant="primary" onclick={confirmDelete}>{i18n.t('chat.delete')}</Button>
  </div>
</Dialog>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: calc(var(--space-unit) * 3);
    max-width: 760px;
    margin: 0 auto;
    /* Room for the pinned composer, so the newest message is never under it. */
    padding-bottom: calc(var(--space-unit) * 36);
  }

  .status {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 2);
    min-height: 1.25rem;
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-success);
  }

  .older {
    align-self: center;
  }

  .edge {
    align-self: center;
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .log {
    display: flex;
    flex-direction: column;
    gap: calc(var(--space-unit) * 3);
  }

  .unread {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 3);
    color: var(--color-accent);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .unread::before,
  .unread::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--color-accent);
  }

  .msg {
    display: grid;
    gap: calc(var(--space-unit) * 0.5);
    max-width: min(78%, 34rem);
    width: fit-content;
  }

  .body {
    padding: calc(var(--space-unit) * 2.5) calc(var(--space-unit) * 3.5);
    border-radius: 16px 16px 16px 4px;
    background: var(--color-surface-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .body a {
    color: inherit;
    text-decoration: underline;
  }

  .msg.me {
    align-self: flex-end;
    justify-items: end;
  }

  .msg.me .body {
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    border-radius: 16px 16px 4px 16px;
  }

  .msg.gone .body,
  .msg.me.gone .body {
    background: transparent;
    border: 1px dashed var(--color-border);
    color: var(--color-muted);
    font-style: italic;
  }

  .msg.failed .body {
    opacity: 0.75;
  }

  .msg.failed strong {
    color: var(--color-danger);
  }

  small {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: calc(var(--space-unit) * 1);
    padding: 0 calc(var(--space-unit) * 3);
    color: var(--color-muted);
    font-size: 0.8125rem;
  }

  .actions {
    display: flex;
    gap: calc(var(--space-unit) * 2);
  }

  .action {
    min-height: 32px;
    padding: 0 calc(var(--space-unit) * 2);
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .action:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .action:hover:not(:disabled) {
    color: var(--color-text);
  }

  .action:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  /* Pinned above the mobile tab bar (at the bottom on wide screens): the connection
     status, any notice and the composer stay in view while the timeline scrolls. */
  .composer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(72px + env(safe-area-inset-bottom));
    z-index: 4;
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
    padding: calc(var(--space-unit) * 1.5) calc(var(--space-unit) * 4) calc(var(--space-unit) * 2.5);
    background: var(--color-surface);
    border-top: 1px solid var(--color-divider);
  }

  .composer-status,
  .composer-inner {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: calc(var(--space-unit) * 2);
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }

  textarea {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    max-height: 9rem;
    padding: calc(var(--space-unit) * 2.5) calc(var(--space-unit) * 3.5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    resize: none;
    field-sizing: content;
  }

  .count {
    order: 3;
    width: 100%;
    color: var(--color-muted);
    font-size: 0.8125rem;
  }

  .count.over {
    color: var(--color-danger);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: calc(var(--space-unit) * 2);
    margin-top: calc(var(--space-unit) * 4);
  }

  .composer-status {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
  }

  @media (min-width: 768px) {
    .composer {
      bottom: 0;
      padding-bottom: calc(var(--space-unit) * 2.5 + env(safe-area-inset-bottom));
    }
  }
</style>
