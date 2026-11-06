<script lang="ts">
  import type { Snippet } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { t as translate } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import type { NavArea, NavItem } from '$lib/nav';

  interface Props {
    /** `logoMediaId` is set for members only (site media is private, §7). */
    site: { name: string; years: string; logoMediaId?: string | null };
    nav: NavItem[];
    /** R-AUTH-27: a page outside Access (/join): no nav, account menu or link into the members' site. */
    publicPage?: boolean;
    children: Snippet;
  }

  let { site, nav, publicPage = false, children }: Props = $props();

  const i18n = useI18n();
  const otherLocale = $derived(i18n.locale === 'vi' ? 'en' : 'vi');
  const pathname = $derived(page.url.pathname);

  let account: HTMLDetailsElement | undefined = $state();

  function closeMenu() {
    if (account) account.open = false;
  }

  // The layout outlives client-side navigation, so the menu must be closed by hand.
  afterNavigate(closeMenu);

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !account?.open) return;
    closeMenu();
    account.querySelector('summary')?.focus();
  }

  function onFocusout(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || !account?.contains(event.relatedTarget)) {
      closeMenu();
    }
  }

  function switchLanguage() {
    i18n.toggleLocale();
    closeMenu();
  }

  const iconPaths: Record<NavArea, string> = {
    home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
    memories: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6',
    discussions: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
    chat: 'M4 12a8 7 0 1 1 3.5 5.8L4 19l1-3.6A7 7 0 0 1 4 12z',
    members:
      'M9 5a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4M3 19c.6-3.4 3-5 6-5s5.4 1.6 6 5M17 7a2.4 2.4 0 1 0 0 4.8M16 14c2.6 0 4.4 1.4 5 4',
  };

  function isCurrent(href: string): boolean {
    return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  }
</script>

<a class="skip-link" href="#main">{i18n.t('shell.skip')}</a>

{#snippet mark()}
  {#if site.logoMediaId}
    <img class="logo" src="/api/v1/media/{site.logoMediaId}/image" alt="" />
  {:else}
    <i class="spine" aria-hidden="true"></i>
  {/if}
  <b>{site.name}</b>
  <span class="tnum">{site.years}</span>
{/snippet}

<header class="top">
  {#if publicPage}
    <span class="brand">{@render mark()}</span>
  {:else}
    <a class="brand" href={resolve('/')}>{@render mark()}</a>
  {/if}

  {#if !publicPage}
    <nav class="areas" aria-label={i18n.t('shell.areas')}>
      {#each nav as item (item.id)}
        <a href={resolve(item.href)} aria-current={isCurrent(item.href) ? 'page' : undefined}>
          {i18n.t(`nav.${item.id}`)}
        </a>
      {/each}
    </nav>
  {/if}

  {#if publicPage}
    <!-- The other language, named in itself: short enough for a 390 px header. -->
    <button
      type="button"
      class="language"
      lang={otherLocale}
      aria-label={i18n.t('shell.switchLanguage')}
      onclick={() => i18n.toggleLocale()}
    >
      {translate(otherLocale, 'shell.language')}
    </button>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- Esc and focusout bubble from the summary and menu controls inside. -->
    <details class="account" bind:this={account} onkeydown={onKeydown} onfocusout={onFocusout}>
      <summary aria-label={i18n.t('shell.account')}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="3.4"></circle>
          <path d="M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4"></path>
        </svg>
      </summary>
      <div class="menu">
        <a href={resolve('/profile')}>{i18n.t('shell.profile')}</a>
        {#if page.data.features?.notifications !== false}
          <a href={resolve('/notifications')}>{i18n.t('nav.notifications')}</a>
        {/if}
        <a href={resolve('/admin')}>{i18n.t('shell.admin')}</a>
        <button type="button" onclick={switchLanguage}>{i18n.t('shell.switchLanguage')}</button>
      </div>
    </details>
  {/if}
</header>

<main id="main" tabindex="-1">
  <div class="content">{@render children()}</div>
</main>

{#if !publicPage}
  <nav class="tabs" aria-label={i18n.t('shell.areas')}>
    {#each nav as item (item.id)}
      <a href={resolve(item.href)} aria-current={isCurrent(item.href) ? 'page' : undefined}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d={iconPaths[item.id]}></path>
        </svg>
        {i18n.t(`nav.${item.id}`)}
      </a>
    {/each}
  </nav>
{/if}

<style>
  .top {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 8);
    height: 56px;
    padding: 0 calc(var(--space-unit) * 4);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-divider);
  }

  @media (min-width: 768px) {
    .top {
      height: 64px;
      padding: 0 max(calc(var(--space-unit) * 6), calc((100vw - var(--content-max)) / 2));
    }
  }

  .brand {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 2.5);
    min-width: 0;
  }

  .spine {
    flex: none;
    width: 5px;
    height: 30px;
    border-radius: 2px;
    background: var(--color-mark);
  }

  .logo {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-control);
    object-fit: cover;
  }

  .brand b {
    font: var(--text-title);
    color: var(--color-accent);
    white-space: nowrap;
  }

  .brand span {
    color: var(--color-muted);
    font-size: 0.875rem;
    white-space: nowrap;
  }

  .areas {
    display: none;
  }

  @media (min-width: 768px) {
    .areas {
      display: flex;
      gap: calc(var(--space-unit) * 1);
      height: 100%;
    }

    .areas a {
      display: flex;
      align-items: center;
      padding: 0 calc(var(--space-unit) * 3);
      color: var(--color-muted);
      font-size: 0.9375rem;
      font-weight: 500;
    }

    .areas a:hover {
      color: var(--color-text);
    }

    .areas a[aria-current] {
      color: var(--color-accent);
      box-shadow: inset 0 -2px 0 var(--color-accent);
    }
  }

  .language {
    flex: none;
    margin-left: auto;
    white-space: nowrap;
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-accent);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }

  .account {
    position: relative;
    margin-left: auto;
  }

  .account summary {
    display: grid;
    place-items: center;
    min-width: 44px;
    min-height: 44px;
    border-radius: 50%;
    background: var(--color-surface-2);
    color: var(--color-accent);
    cursor: pointer;
    list-style: none;
  }

  .account summary::-webkit-details-marker {
    display: none;
  }

  .account svg {
    width: 22px;
    height: 22px;
  }

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + var(--space-unit) * 2);
    min-width: 12rem;
    display: grid;
    padding: calc(var(--space-unit) * 2);
    background: var(--color-surface);
    border: 1px solid var(--color-divider);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }

  .menu a,
  .menu button {
    padding: calc(var(--space-unit) * 2.5) calc(var(--space-unit) * 3);
    border-radius: var(--radius-control);
    text-align: left;
    font-size: 0.9375rem;
    font-weight: 500;
  }

  .menu a:hover,
  .menu button:hover {
    background: var(--color-surface-2);
    color: var(--color-accent);
  }

  main {
    max-width: var(--content-max);
    margin: 0 auto;
    padding: calc(var(--space-unit) * 6) calc(var(--space-unit) * 4)
      calc(72px + env(safe-area-inset-bottom) + var(--space-unit) * 4);
  }

  @media (min-width: 768px) {
    main {
      padding: calc(var(--space-unit) * 9) calc(var(--space-unit) * 6) calc(var(--space-unit) * 9);
    }
  }

  .content {
    min-width: 0;
  }

  .tabs {
    position: fixed;
    z-index: 5;
    left: 0;
    right: 0;
    bottom: 0;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    height: calc(72px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--color-surface);
    border-top: 1px solid var(--color-divider);
  }

  .tabs a {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 44px;
    color: var(--color-muted);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .tabs a[aria-current] {
    color: var(--color-accent);
    box-shadow: inset 0 2px 0 var(--color-accent);
  }

  .tabs svg {
    width: 24px;
    height: 24px;
  }

  @media (min-width: 768px) {
    .tabs {
      display: none;
    }
  }
</style>
