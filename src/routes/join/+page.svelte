<script lang="ts">
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const i18n = useI18n();

  // R-AUTH-28: one confirmation for every accepted submission, whatever the email.
  const sent = $derived(!!form && 'sent' in form);
  const closed = $derived(data.closed || (!!form && 'closed' in form));
  const values = $derived(form && 'values' in form ? form.values : undefined);
  const fieldError = (name: string) =>
    form && 'fields' in form && form.fields && name in form.fields
      ? i18n.t('error.validation')
      : undefined;
  const retry = $derived(form && 'retry' in form ? form.retry : null);
</script>

<svelte:head>
  {#if data.turnstile && !sent && !closed}
    <!-- R-AUTH-24: the one third-party script, on this page only (its CSP admits it). -->
    <script src={data.turnstile.script} async defer></script>
  {/if}
</svelte:head>

<PageHeader title={i18n.t('join.title')} lede={sent || closed ? undefined : i18n.t('join.lede')} />

<div class="join">
  {#if sent}
    <Card class="sheet">
      <EmptyState title={i18n.t('join.sent.title')} body={i18n.t('join.sent.body')} />
    </Card>
  {:else if closed}
    <Card class="sheet">
      <EmptyState title={i18n.t('join.closed.title')} body={i18n.t('join.closed.body')} />
    </Card>
  {:else}
    <Card class="sheet">
      {#if retry}
        <Banner tone="danger">{i18n.t(`join.retry.${retry}`)}</Banner>
      {/if}
      <!-- Works without JavaScript apart from Turnstile, which needs it to issue a token. -->
      <form method="POST" class="form">
        <FormField
          id="join-name"
          name="name"
          label={i18n.t('join.name')}
          autocomplete="name"
          maxlength={80}
          required
          value={values?.name ?? ''}
          error={fieldError('name')}
        />
        <FormField
          id="join-email"
          name="email"
          type="email"
          label={i18n.t('join.email')}
          hint={i18n.t('join.emailHint')}
          autocomplete="email"
          maxlength={254}
          required
          value={values?.email ?? ''}
          error={fieldError('email')}
        />
        <FormField
          id="join-note"
          name="note"
          label={i18n.t('join.note')}
          hint={i18n.t('join.noteHint')}
          multiline
          maxlength={300}
          value={values?.note ?? ''}
          error={fieldError('note')}
        />
        {#if data.turnstile}
          <div
            class="cf-turnstile"
            data-sitekey={data.turnstile.siteKey}
            data-language={i18n.locale}
            data-size="flexible"
          ></div>
        {/if}
        <div>
          <Button type="submit" variant="primary">{i18n.t('join.submit')}</Button>
        </div>
      </form>
    </Card>
  {/if}
</div>

<style>
  .join :global(.sheet) {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    padding: calc(var(--space-unit) * 5);
    max-width: 40rem;
  }

  .form {
    display: grid;
    gap: calc(var(--space-unit) * 4);
  }

  .cf-turnstile {
    min-height: 65px;
  }
</style>
