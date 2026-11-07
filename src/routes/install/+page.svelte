<script lang="ts">
  import { page } from '$app/state';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { InstallKind } from '$lib/install/detect';
  import { installState } from '$lib/install/state.svelte';
  import type { MessageKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const i18n = useI18n();

  const others: { kind: Exclude<InstallKind, 'installed' | 'unsupported'>; label: MessageKey }[] = [
    { kind: 'prompt', label: 'install.other.prompt' },
    { kind: 'ios', label: 'install.other.ios' },
    { kind: 'android-menu', label: 'install.other.androidMenu' },
    { kind: 'in-app', label: 'install.other.inApp' },
    { kind: 'desktop-menu', label: 'install.other.desktopMenu' },
  ];

  const kind = $derived(installState.kind);
  const steps = (k: InstallKind): MessageKey => {
    switch (k) {
      case 'installed':
        return 'install.installed';
      case 'prompt':
        return 'install.prompt';
      case 'ios':
        return 'install.ios';
      case 'android-menu':
        return 'install.androidMenu';
      case 'desktop-menu':
        return 'install.desktopMenu';
      case 'in-app':
        return installState.ios ? 'install.inAppIos' : 'install.inAppAndroid';
      default:
        return 'install.unsupported';
    }
  };
  const needsSignInNote = $derived(kind === 'ios' || (kind === 'in-app' && installState.ios));

  // `page.url` is the origin the server saw, which is the one the member opened.
  const link = $derived(`${page.url.origin}/`);
  let copied = $state(false);
  let field = $state<HTMLInputElement>();

  // R-NAV-10: the Clipboard API, falling back to the selected read-only field.
  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch {
      field?.focus();
      field?.select();
    }
  }
</script>

<PageHeader
  title={i18n.t('install.title')}
  lede={i18n.t('install.lede', { name: data.site.name })}
/>

<div class="install">
  <Card class="steps">
    {#if installState.ready}
      <p class="current" data-kind={kind}>{i18n.t(steps(kind))}</p>
      {#if kind === 'prompt'}
        <Button variant="primary" onclick={() => installState.install()}>
          {i18n.t('install.button')}
        </Button>
      {/if}
      {#if kind === 'in-app'}
        <div class="copy">
          <label for="install-link">{i18n.t('install.linkLabel')}</label>
          <input id="install-link" bind:this={field} readonly value={link} />
          <Button onclick={copyLink}>{i18n.t('install.copyLink')}</Button>
          <p class="note" role="status">{copied ? i18n.t('install.copied') : ''}</p>
        </div>
      {/if}
      {#if needsSignInNote}
        <p class="note">{i18n.t('install.iosSignIn')}</p>
      {/if}
      {#if kind !== 'installed' && kind !== 'unsupported'}
        <p class="note">{i18n.t('install.pushNext')}</p>
      {/if}
    {/if}
  </Card>

  <details class="others">
    <summary>{i18n.t('install.others')}</summary>
    <dl>
      {#each others.filter((other) => other.kind !== kind) as other (other.kind)}
        <dt>{i18n.t(other.label)}</dt>
        <dd>
          {i18n.t(other.kind === 'in-app' ? 'install.inAppIos' : steps(other.kind))}
          {#if other.kind === 'in-app'}
            {i18n.t('install.inAppAndroid')}
          {/if}
          {#if other.kind === 'ios'}
            {i18n.t('install.iosSignIn')}
          {/if}
        </dd>
      {/each}
    </dl>
  </details>
</div>

<style>
  .install {
    display: grid;
    gap: calc(var(--space-unit) * 5);
    max-width: 40rem;
  }
  :global(.steps) {
    padding: calc(var(--space-unit) * 5);
    display: grid;
    gap: calc(var(--space-unit) * 3);
    justify-items: start;
  }
  .current {
    margin: 0;
    font-size: 1.125rem;
  }
  .note {
    margin: 0;
    color: var(--color-muted);
  }
  .copy {
    display: grid;
    gap: calc(var(--space-unit) * 2);
    justify-items: start;
    width: 100%;
  }
  input {
    width: 100%;
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 calc(var(--space-unit) * 3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }
  summary {
    cursor: pointer;
    padding: calc(var(--space-unit) * 3) 0;
    font-weight: 600;
  }
  dt {
    font-weight: 600;
    margin-top: calc(var(--space-unit) * 3);
  }
  dd {
    margin: 0;
    color: var(--color-muted);
  }
</style>
