<script lang="ts">
  import '../app.css';
  import '@fontsource/be-vietnam-pro/400.css';
  import '@fontsource/be-vietnam-pro/500.css';
  import '@fontsource/be-vietnam-pro/600.css';
  import '@fontsource/be-vietnam-pro/700.css';
  import '@fontsource/patrick-hand/400.css';
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import AppShell from '$lib/components/AppShell.svelte';
  import Banner from '$lib/components/Banner.svelte';
  import { provideI18n } from '$lib/i18n/context';
  import { storeLocale, t as translate, type Locale, type MessageKey } from '$lib/i18n';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  let override = $state<Locale | null>(null);
  const locale = $derived(override ?? data.locale);

  function setLocale(next: Locale): void {
    override = next;
    storeLocale(next);
    document.documentElement.lang = next;
    document.documentElement.dataset.locale = next;
  }

  function toggleLocale(): void {
    setLocale(locale === 'vi' ? 'en' : 'vi');
  }

  provideI18n({
    get locale() {
      return locale;
    },
    t: (key: MessageKey, params) => translate(locale, key, params),
    setLocale,
    toggleLocale,
  });

  onMount(() => {
    document.documentElement.dataset.locale = locale;
  });
</script>

<AppShell site={data.site} nav={data.nav}>
  <!-- R-MEM-15: admins only; the layout load never reads usage for anyone else. -->
  {#if data.storageWarning}
    <div class="storage">
      <Banner tone="warning"
        >{translate(locale, 'admin.usage.banner')}
        <a href={resolve('/admin')}>{translate(locale, 'admin.usage.bannerLink')}</a></Banner
      >
    </div>
  {/if}
  {@render children()}
</AppShell>

<style>
  .storage {
    margin-bottom: calc(var(--space-unit) * 4);
  }

  .storage a {
    color: var(--color-accent);
    font-weight: 600;
    text-decoration: underline;
  }
</style>
