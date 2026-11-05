<script lang="ts">
  import Button from '$lib/components/Button.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { siteConfig } from '$lib/config';
  import { useI18n } from '$lib/i18n/context';

  const i18n = useI18n();

  const messages = $derived([
    {
      author: i18n.t('demo.copy4'),
      time: i18n.t('demo.copy36'),
      text: i18n.t('demo.copy37'),
      own: false,
    },
    {
      author: i18n.t('demo.copy6'),
      time: i18n.t('demo.copy38'),
      text: i18n.t('demo.copy39'),
      own: false,
    },
    {
      author: i18n.t('demo.copy10'),
      time: i18n.t('demo.copy40'),
      text: i18n.t('demo.copy41'),
      own: false,
    },
    {
      author: i18n.t('demo.copy42'),
      time: i18n.t('demo.copy43'),
      text: i18n.t('demo.copy44'),
      own: true,
    },
  ]);
</script>

<PageHeader
  title={i18n.t('chat.title')}
  lede={i18n.t('chat.lede', { days: siteConfig.chat.retainDays })}
/>

<div class="chat">
  <span class="day">{i18n.t('chat.yesterday')}</span>
  {#each messages.slice(0, 2) as message (message.time)}
    <div class="msg">
      <small>{message.author} · {message.time}</small>
      <p>{message.text}</p>
    </div>
  {/each}

  <span class="day">{i18n.t('chat.today')}</span>
  {#each messages.slice(2) as message (message.time)}
    <div class="msg" class:me={message.own}>
      <small>{message.author} · {message.time}</small>
      <p>{message.text}</p>
    </div>
  {/each}
</div>

<div class="composer">
  <div class="composer-inner">
    <FormField
      id="message"
      label={i18n.t('chat.composer')}
      placeholder={i18n.t('chat.composer')}
      labelHidden
    />
    <Button variant="primary">{i18n.t('chat.send')}</Button>
  </div>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: calc(var(--space-unit) * 1.5);
    max-width: 760px;
    margin: 0 auto;
    padding-bottom: calc(var(--space-unit) * 24);
  }

  .day {
    align-self: center;
    margin: calc(var(--space-unit) * 3) 0;
    color: var(--color-muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .msg {
    display: grid;
    gap: calc(var(--space-unit) * 0.5);
    max-width: 78%;
    width: fit-content;
  }

  .msg p {
    padding: calc(var(--space-unit) * 2.5) calc(var(--space-unit) * 3.5);
    border-radius: 16px 16px 16px 4px;
    background: var(--color-surface-2);
  }

  .msg.me {
    align-self: flex-end;
  }

  .msg.me p {
    background: var(--color-accent);
    color: var(--color-accent-contrast);
    border-radius: 16px 16px 4px 16px;
  }

  small {
    padding: 0 calc(var(--space-unit) * 3);
    color: var(--color-muted);
    font-size: 0.8125rem;
  }

  .msg.me small {
    text-align: right;
  }

  .composer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(72px + env(safe-area-inset-bottom));
    z-index: 4;
    display: flex;
    align-items: flex-end;
    gap: calc(var(--space-unit) * 2);
    padding: calc(var(--space-unit) * 2.5) calc(var(--space-unit) * 4);
    background: var(--color-surface);
    border-top: 1px solid var(--color-divider);
  }

  .composer-inner {
    display: flex;
    align-items: flex-end;
    gap: calc(var(--space-unit) * 2);
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }

  @media (min-width: 768px) {
    .composer {
      bottom: 0;
    }
  }

  .composer :global(.field) {
    flex: 1;
  }
</style>
