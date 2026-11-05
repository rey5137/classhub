<script lang="ts">
  import '../app.css';
  import '@fontsource/be-vietnam-pro/400.css';
  import '@fontsource/be-vietnam-pro/500.css';
  import '@fontsource/be-vietnam-pro/600.css';
  import '@fontsource/be-vietnam-pro/700.css';
  import '@fontsource/patrick-hand/400.css';
  import { onMount } from 'svelte';
  import AppShell from '$lib/components/AppShell.svelte';
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
  {@render children()}
</AppShell>
