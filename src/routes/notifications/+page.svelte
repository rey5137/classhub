<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import {
    deriveDeviceLabel,
    muteChoices,
    type DevicePushState,
    type MuteChoice,
    type NotificationDeviceView,
    type NotificationKinds,
  } from '$lib/contracts/notifications';
  import { useI18n } from '$lib/i18n/context';
  import { installState } from '$lib/install/state.svelte';
  import { fullTime, mediumDate } from '$lib/shared/time';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const i18n = useI18n();

  let vapidPublicKey = $derived(data.notifications.vapidPublicKey);
  let kindsOverride = $state<NotificationKinds | null>(null);
  let muteUntilOverride = $state<number | null | undefined>(undefined);
  let quietOverride = $state<boolean | null>(null);
  let devicesOverride = $state<NotificationDeviceView[] | null>(null);

  let kinds = $derived(kindsOverride ?? data.notifications.kinds);
  let muteUntil = $derived(
    muteUntilOverride !== undefined ? muteUntilOverride : data.notifications.muteUntil,
  );
  let quiet = $derived(quietOverride ?? data.notifications.quiet);
  let devices = $derived(devicesOverride ?? data.notifications.devices);
  let browserState = $state<DevicePushState | null>(null);
  let activeDeviceId = $state<string | null>(null);
  let busy = $state(false);
  let statusMessage = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);

  const iosNeedsInstall = $derived(
    installState.ready &&
      (installState.kind === 'ios' || (installState.kind === 'in-app' && installState.ios)),
  );

  const effectiveDeviceState = $derived<DevicePushState>(
    !vapidPublicKey ? 'unavailable' : (browserState ?? data.notifications.deviceState),
  );

  const isMuted = $derived(muteUntil !== null && muteUntil > Date.now());

  function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padded = base64String.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const raw = atob(padded + '='.repeat(padLen));
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      output[i] = raw.charCodeAt(i);
    }
    return output;
  }

  function bufferToBase64Url(buf: ArrayBuffer | null): string {
    if (!buf) return '';
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function extractSubscriptionKeys(sub: PushSubscription): {
    endpoint: string;
    p256dh: string;
    auth: string;
  } | null {
    const endpoint = sub.endpoint;
    const json = typeof sub.toJSON === 'function' ? sub.toJSON() : undefined;
    const p256dh =
      json?.keys?.p256dh ??
      (typeof sub.getKey === 'function' ? bufferToBase64Url(sub.getKey('p256dh')) : '');
    const auth =
      json?.keys?.auth ??
      (typeof sub.getKey === 'function' ? bufferToBase64Url(sub.getKey('auth')) : '');
    if (!endpoint || !p256dh || !auth) return null;
    return { endpoint, p256dh, auth };
  }

  async function getPushManager(): Promise<PushManager | null> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
    try {
      const existingReg = await navigator.serviceWorker.getRegistration?.();
      if (existingReg?.pushManager) return existingReg.pushManager;
      const readyReg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      return readyReg?.pushManager ?? null;
    } catch {
      return null;
    }
  }

  async function refreshFromApi(): Promise<void> {
    const res = await fetch('/api/v1/notifications');
    if (!res.ok) return;
    const body = (await res.json()) as typeof data.notifications;
    kindsOverride = { ...body.kinds };
    muteUntilOverride = body.muteUntil;
    quietOverride = body.quiet;
    devicesOverride = [...body.devices];
  }

  async function postBrowserSubscription(sub: PushSubscription): Promise<string | null> {
    const extracted = extractSubscriptionKeys(sub);
    if (!extracted) return null;
    const label = deriveDeviceLabel(navigator.userAgent);
    const res = await fetch('/api/v1/notifications/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...extracted,
        locale: i18n.locale,
        deviceLabel: label,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string };
    await refreshFromApi();
    return json.id ?? null;
  }

  // R-NTF-10, 11: inspect browser permission and subscription on load without ever prompting.
  // When permission is already granted and the browser holds an unlisted subscription, post it once.
  let healedOnLoad = false;
  onMount(async () => {
    if (!vapidPublicKey) {
      browserState = 'unavailable';
      return;
    }
    if (
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      browserState = 'unsupported';
      return;
    }
    if (Notification.permission === 'denied') {
      browserState = 'blocked';
      return;
    }
    if (Notification.permission !== 'granted') {
      browserState = 'off';
      return;
    }
    const pm = await getPushManager();
    if (!pm) {
      browserState = 'unsupported';
      return;
    }
    const sub = await pm.getSubscription();
    if (!sub) {
      browserState = 'off';
      return;
    }
    const thisLabel = deriveDeviceLabel(navigator.userAgent);
    const matching = devices.find((d) => d.deviceLabel === thisLabel);
    if (!matching && !healedOnLoad) {
      healedOnLoad = true;
      const id = await postBrowserSubscription(sub);
      if (id) activeDeviceId = id;
    } else if (matching) {
      activeDeviceId = matching.id;
    }
    browserState = 'on';
  });

  // R-NTF-10 / AC-NTF-12: requests permission only from a tap on "Turn on for this device".
  async function turnOnDevice(): Promise<void> {
    if (!vapidPublicKey || busy) return;
    busy = true;
    errorMessage = null;
    statusMessage = null;
    try {
      if (typeof Notification === 'undefined') {
        browserState = 'unsupported';
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        browserState = permission === 'denied' ? 'blocked' : 'off';
        return;
      }
      const pm = await getPushManager();
      if (!pm) {
        browserState = 'unsupported';
        return;
      }
      const existing = await pm.getSubscription();
      const sub =
        existing ??
        (await pm.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));
      const id = await postBrowserSubscription(sub);
      if (!id) {
        errorMessage = i18n.t('notifications.error.invalid');
        return;
      }
      activeDeviceId = id;
      browserState = 'on';
      statusMessage = i18n.t('notifications.done.deviceAdded');
    } catch {
      errorMessage = i18n.t('notifications.error.invalid');
    } finally {
      busy = false;
    }
  }

  async function turnOffDevice(): Promise<void> {
    if (busy) return;
    busy = true;
    errorMessage = null;
    statusMessage = null;
    try {
      const pm = await getPushManager();
      const sub = await pm?.getSubscription();
      if (sub) {
        await sub.unsubscribe().catch(() => {});
      }
      const thisLabel = deriveDeviceLabel(navigator.userAgent);
      const targetId = activeDeviceId ?? devices.find((d) => d.deviceLabel === thisLabel)?.id;
      if (targetId) {
        await fetch(`/api/v1/notifications/subscriptions/${encodeURIComponent(targetId)}`, {
          method: 'DELETE',
        });
        devicesOverride = devices.filter((d) => d.id !== targetId);
        activeDeviceId = null;
      }
      browserState = 'off';
      statusMessage = i18n.t('notifications.done.deviceRemoved');
    } finally {
      busy = false;
    }
  }

  async function toggleKind(key: keyof NotificationKinds, checked: boolean): Promise<void> {
    kindsOverride = { ...kinds, [key]: checked };
    statusMessage = null;
    errorMessage = null;
    const res = await fetch('/api/v1/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: { [key]: checked } }),
    });
    if (res.ok) {
      const body = (await res.json()) as typeof data.notifications;
      kindsOverride = { ...body.kinds };
      statusMessage = i18n.t('notifications.done.saved');
    }
  }

  async function saveKindsForm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const payload: Partial<NotificationKinds> = {
      chat: kinds.chat,
      thread: kinds.thread,
      reply: kinds.reply,
      ...(data.isAdmin ? { join: kinds.join } : {}),
    };
    const res = await fetch('/api/v1/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: payload }),
    });
    if (res.ok) {
      const body = (await res.json()) as typeof data.notifications;
      kindsOverride = { ...body.kinds };
      statusMessage = i18n.t('notifications.done.saved');
    }
  }

  async function applyMute(choice: MuteChoice | null): Promise<void> {
    statusMessage = null;
    errorMessage = null;
    const res = await fetch('/api/v1/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mute: choice }),
    });
    if (res.ok) {
      const body = (await res.json()) as typeof data.notifications;
      muteUntilOverride = body.muteUntil;
      statusMessage = choice
        ? i18n.t('notifications.done.muted')
        : i18n.t('notifications.done.unmuted');
    }
  }

  async function removeDevice(id: string): Promise<void> {
    statusMessage = null;
    errorMessage = null;
    const res = await fetch(`/api/v1/notifications/subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const next = devices.filter((d) => d.id !== id);
      devicesOverride = next;
      if (activeDeviceId === id) {
        activeDeviceId = null;
        browserState = 'off';
      } else if (next.length === 0 && browserState === 'on') {
        browserState = 'off';
      }
      statusMessage = i18n.t('notifications.done.deviceRemoved');
    }
  }

  const formatDate = (at: number) => mediumDate(at, i18n.locale, data.timeZone);
  const formatUntil = (at: number) => fullTime(at, i18n.locale, data.timeZone);
</script>

<PageHeader title={i18n.t('notifications.title')} lede={i18n.t('notifications.lede')} />

<div class="notifications-page">
  {#if quiet}
    <Banner tone="info">{i18n.t('notifications.quiet.banner')}</Banner>
  {/if}

  {#if statusMessage}
    <p class="status" role="status">{statusMessage}</p>
  {/if}
  {#if errorMessage}
    <p class="error" role="alert">{errorMessage}</p>
  {/if}

  <Card class="section">
    <h2>{i18n.t('notifications.device.heading')}</h2>
    <p class="device-state" data-state={effectiveDeviceState}>
      {i18n.t(`notifications.device.state.${effectiveDeviceState}`)}
    </p>

    {#if effectiveDeviceState === 'unavailable'}
      <p class="hint">{i18n.t('notifications.device.privacyHint')}</p>
    {:else if iosNeedsInstall}
      <p class="hint">{i18n.t('notifications.device.iosInstallHint')}</p>
      <p class="install-action">
        <a class="install-link" href={resolve('/install')}>
          {i18n.t('notifications.device.iosInstallLink')}
        </a>
      </p>
    {:else if effectiveDeviceState === 'blocked'}
      <p class="hint">{i18n.t('notifications.device.blockedHint')}</p>
    {:else if effectiveDeviceState === 'unsupported'}
      <p class="hint">{i18n.t('notifications.device.unsupportedHint')}</p>
    {:else if effectiveDeviceState === 'on'}
      <div class="actions">
        <Button onclick={turnOffDevice} disabled={busy}>
          {i18n.t('notifications.device.turnOff')}
        </Button>
      </div>
    {:else}
      <div class="actions">
        <Button variant="primary" onclick={turnOnDevice} disabled={busy}>
          {i18n.t('notifications.device.turnOn')}
        </Button>
      </div>
    {/if}

    <p class="hint">{i18n.t('notifications.device.privacyHint')}</p>
  </Card>

  <Card class="section">
    <h2>{i18n.t('notifications.kinds.heading')}</h2>
    <p class="hint">{i18n.t('notifications.kinds.hint')}</p>

    <form method="POST" action="?/kinds" onsubmit={saveKindsForm} class="kinds-form">
      <label class="kind-row">
        <input
          type="checkbox"
          name="chat"
          checked={kinds.chat}
          onchange={(e) => toggleKind('chat', (e.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          <strong>{i18n.t('notifications.kinds.chat')}</strong>
          <small>{i18n.t('notifications.kinds.chatHint')}</small>
        </span>
      </label>

      <label class="kind-row">
        <input
          type="checkbox"
          name="thread"
          checked={kinds.thread}
          onchange={(e) => toggleKind('thread', (e.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          <strong>{i18n.t('notifications.kinds.thread')}</strong>
          <small>{i18n.t('notifications.kinds.threadHint')}</small>
        </span>
      </label>

      <label class="kind-row">
        <input
          type="checkbox"
          name="reply"
          checked={kinds.reply}
          onchange={(e) => toggleKind('reply', (e.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          <strong>{i18n.t('notifications.kinds.reply')}</strong>
          <small>{i18n.t('notifications.kinds.replyHint')}</small>
        </span>
      </label>

      {#if data.isAdmin}
        <label class="kind-row">
          <input
            type="checkbox"
            name="join"
            checked={kinds.join}
            onchange={(e) => toggleKind('join', (e.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            <strong>{i18n.t('notifications.kinds.join')}</strong>
            <small>{i18n.t('notifications.kinds.joinHint')}</small>
          </span>
        </label>
      {/if}

      <div class="actions">
        <Button type="submit">{i18n.t('notifications.kinds.save')}</Button>
      </div>
    </form>
  </Card>

  <Card class="section">
    <h2>{i18n.t('notifications.mute.heading')}</h2>

    {#if isMuted && muteUntil !== null}
      <div class="mute-active">
        <p>{i18n.t('notifications.mute.active', { until: formatUntil(muteUntil) })}</p>
        <Button onclick={() => applyMute(null)}>{i18n.t('notifications.mute.unmute')}</Button>
      </div>
    {:else}
      <div class="mute-choices">
        {#each muteChoices as choice (choice)}
          <Button onclick={() => applyMute(choice)}>
            {i18n.t(`notifications.mute.${choice}`)}
          </Button>
        {/each}
      </div>
    {/if}
  </Card>

  <Card class="section">
    <h2>{i18n.t('notifications.devices.heading')}</h2>

    {#if devices.length === 0}
      <p class="hint">{i18n.t('notifications.devices.empty')}</p>
    {:else}
      <ul class="device-list">
        {#each devices as device (device.id)}
          <li class="device-item">
            <div class="device-meta">
              <strong>{device.deviceLabel}</strong>
              <span class="hint">
                {i18n.t('notifications.devices.added', { date: formatDate(device.createdAt) })}
              </span>
            </div>
            <Button onclick={() => removeDevice(device.id)}>
              {i18n.t('notifications.devices.remove')}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>
</div>

<style>
  .notifications-page {
    display: grid;
    gap: calc(var(--space-unit) * 4);
  }

  .notifications-page :global(.section) {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 5);
  }

  h2 {
    margin: 0;
    font: var(--text-heading);
  }

  p {
    margin: 0;
  }

  .device-state {
    font-weight: 600;
  }

  .hint {
    color: var(--color-muted);
    font: var(--text-small);
  }

  .status {
    color: var(--color-text);
    font: var(--text-small);
  }

  .error {
    color: var(--color-danger);
    font: var(--text-small);
  }

  .install-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }

  .kinds-form {
    display: grid;
    gap: calc(var(--space-unit) * 3);
  }

  .kind-row {
    display: flex;
    align-items: flex-start;
    gap: calc(var(--space-unit) * 2.5);
    min-height: 44px;
    cursor: pointer;
  }

  .kind-row input[type='checkbox'] {
    inline-size: 1.25rem;
    block-size: 1.25rem;
    margin-block-start: 0.2rem;
    accent-color: var(--color-accent);
    flex-shrink: 0;
  }

  .kind-row span {
    display: grid;
    gap: calc(var(--space-unit) * 0.5);
  }

  .kind-row small {
    color: var(--color-muted);
    font: var(--text-small);
  }

  .actions,
  .mute-choices,
  .mute-active {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: calc(var(--space-unit) * 2);
  }

  .device-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: calc(var(--space-unit) * 2);
  }

  .device-item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 2);
    padding-block: calc(var(--space-unit) * 1.5);
    border-block-start: 1px solid var(--color-divider);
  }

  .device-item:first-child {
    border-block-start: none;
    padding-block-start: 0;
  }

  .device-meta {
    display: grid;
    gap: calc(var(--space-unit) * 0.5);
  }
</style>
