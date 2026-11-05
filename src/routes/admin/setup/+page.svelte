<script lang="ts">
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { MessageKey } from '$lib/i18n';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const i18n = useI18n();

  // R-AUTH-12 / R-OPS-11: what the bootstrap admin does before `npm run unlock`. The
  // page shows only the lock state; preflight on the admin's machine checks the rest.
  const steps = $derived<{ key: MessageKey; done: boolean; body?: MessageKey; command?: string }[]>(
    [
      { key: 'setup.step.access', done: true },
      { key: 'setup.step.signin', done: true },
      { key: 'setup.step.secondAdmin', done: false, body: 'setup.step.secondAdminBody' },
      { key: 'setup.step.preflight', done: data.unlocked, command: 'npm run preflight' },
      { key: 'setup.step.unlock', done: data.unlocked, command: 'npm run unlock' },
    ],
  );
</script>

<PageHeader
  title={i18n.t('setup.title')}
  lede={i18n.t(data.unlocked ? 'setup.ledeOpen' : 'setup.lede')}
/>

<div class="setup">
  <Card class="sheet">
    <p class="state" class:open={data.unlocked}>
      {data.unlocked ? i18n.t('setup.unlocked') : i18n.t('setup.locked')}
    </p>
    <ol class="steps">
      {#each steps as step (step.key)}
        <li class:done={step.done}>
          <span class="mark">{step.done ? i18n.t('setup.done') : i18n.t('setup.todo')}</span>
          <div class="text">
            <p class="title">{i18n.t(step.key)}</p>
            {#if step.body}<p class="body">{i18n.t(step.body)}</p>{/if}
            {#if step.command}<code>{step.command}</code>{/if}
          </div>
        </li>
      {/each}
    </ol>
  </Card>
</div>

<style>
  .setup :global(.sheet) {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    padding: calc(var(--space-unit) * 5);
  }

  .state {
    font-weight: 600;
    color: var(--color-warning);
  }

  .state.open {
    color: var(--color-success);
  }

  .steps {
    display: grid;
    list-style: none;
    padding: 0;
    margin: 0;
  }

  li {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr);
    gap: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 3) 0;
    border-top: 1px solid var(--color-divider);
  }

  .mark {
    color: var(--color-muted);
    font: var(--text-small);
    font-weight: 600;
  }

  li.done .mark {
    color: var(--color-success);
  }

  .text {
    display: grid;
    gap: calc(var(--space-unit) * 1);
    min-width: 0;
  }

  .title {
    font-weight: 600;
  }

  .body {
    color: var(--color-muted);
    font: var(--text-small);
  }

  code {
    overflow-wrap: anywhere;
  }
</style>
