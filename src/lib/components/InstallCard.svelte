<script lang="ts">
  import { resolve } from '$app/paths';
  import { installState } from '$lib/install/state.svelte';
  import { useI18n } from '$lib/i18n/context';
  import Button from './Button.svelte';
  import Card from './Card.svelte';

  const i18n = useI18n();
</script>

<!-- R-NAV-11: client-only; `cardVisible` is false until the browser has been read. -->
{#if installState.cardVisible}
  <Card class="install-card" aria-label={i18n.t('install.title')}>
    <p class="line">{i18n.t('install.card.text')}</p>
    <div class="actions">
      {#if installState.kind === 'prompt'}
        <Button variant="primary" onclick={() => installState.install()}>
          {i18n.t('install.button')}
        </Button>
      {:else}
        <a class="link" href={resolve('/install')}>{i18n.t('install.card.link')}</a>
      {/if}
      <Button variant="ghost" onclick={() => installState.dismiss()}>
        {i18n.t('install.card.dismiss')}
      </Button>
    </div>
  </Card>
{/if}

<style>
  :global(.install-card) {
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
