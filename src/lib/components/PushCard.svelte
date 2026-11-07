<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import {
    PUSH_CARD_DISMISSED_KEY,
    pushCardVisible,
    pushSupported,
    turnOnPush,
  } from '$lib/client/push';
  import { useI18n } from '$lib/i18n/context';
  import { installState } from '$lib/install/state.svelte';
  import Button from './Button.svelte';
  import Card from './Card.svelte';

  const i18n = useI18n();

  // R-NTF-14: client-only; nothing renders until the browser and the server's push state are read.
  let vapidPublicKey = $state<string | null>(null);
  let visible = $state(false);
  let busy = $state(false);
  let done = $state(false);
  let failed = $state(false);

  function read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  onMount(async () => {
    installState.start();
    const show = pushCardVisible({
      installed: installState.kind === 'installed',
      supported: pushSupported(),
      permission: typeof Notification === 'undefined' ? null : Notification.permission,
      dismissedAt: read(PUSH_CARD_DISMISSED_KEY),
      now: Date.now(),
    });
    if (!show) return;
    try {
      const res = await fetch('/api/v1/notifications');
      if (!res.ok) return;
      const body = (await res.json()) as { vapidPublicKey: string | null };
      vapidPublicKey = body.vapidPublicKey;
      visible = vapidPublicKey !== null;
    } catch {
      /* offline: the card waits for the next visit */
    }
  });

  function dismiss(): void {
    try {
      localStorage.setItem(PUSH_CARD_DISMISSED_KEY, String(Date.now()));
    } catch {
      /* private mode: the card returns next visit */
    }
    visible = false;
  }

  async function turnOn(): Promise<void> {
    if (!vapidPublicKey || busy) return;
    busy = true;
    failed = false;
    try {
      const result = await turnOnPush(vapidPublicKey, i18n.locale);
      if (result.state === 'on') done = true;
      else if (result.state === 'failed') failed = true;
      // A refused or dismissed prompt: the browser has its answer, so the card has nothing to ask.
      else visible = false;
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

{#if visible}
  <Card class="push-card" aria-label={i18n.t('notifications.title')}>
    {#if done}
      <p class="line" role="status">{i18n.t('notifications.done.deviceAdded')}</p>
      <div class="actions">
        <a class="link" href={resolve('/notifications')}>{i18n.t('push.card.settings')}</a>
        <Button variant="ghost" onclick={() => (visible = false)}
          >{i18n.t('push.card.close')}</Button
        >
      </div>
    {:else}
      <p class="line">
        {i18n.t('push.card.text')}
        {#if failed}
          <span class="error" role="alert">{i18n.t('notifications.error.invalid')}</span>
        {/if}
      </p>
      <div class="actions">
        <Button variant="primary" onclick={turnOn} disabled={busy}>
          {i18n.t('push.card.button')}
        </Button>
        <Button variant="ghost" onclick={dismiss}>{i18n.t('install.card.dismiss')}</Button>
      </div>
    {/if}
  </Card>
{/if}

<style>
  :global(.push-card) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 4);
    margin-bottom: calc(var(--space-unit) * 5);
  }
  .line {
    margin: 0;
    flex: 1 1 14rem;
  }
  .error {
    display: block;
    margin-top: calc(var(--space-unit) * 1);
    color: var(--color-danger);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 2);
  }
  .link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }
</style>
