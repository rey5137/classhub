<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();
</script>

<PageHeader title={i18n.t('locked.title')} />

<EmptyState body={i18n.t('locked.body')} />
