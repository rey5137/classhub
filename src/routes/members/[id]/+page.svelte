<script lang="ts">
  import { resolve } from '$app/paths';
  import { goBack } from '$lib/client/backstack';
  import Avatar from '$lib/components/Avatar.svelte';
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const i18n = useI18n();

  const person = $derived(data.profile);
  // Only links the server built from normalized values (R-PROF-06): tel:, mailto:, https:.
  const contacts = $derived(
    [
      person.phone && { label: i18n.t('member.phone'), ...person.phone },
      person.contactEmail && { label: i18n.t('member.email'), ...person.contactEmail },
      person.messagingUrl && { label: i18n.t('member.messaging'), ...person.messagingUrl },
    ].filter((item) => !!item),
  );
</script>

<PageHeader title={person.displayName}>
  {#snippet actions()}
    <a class="back" href={resolve('/members')} onclick={(event) => goBack(event, '/members')}
      >{i18n.t('member.back')}</a
    >
  {/snippet}
</PageHeader>

<div class="member-page">
  <Card class="member">
    <Avatar name={person.displayName} size="lg" mediaId={person.avatarMediaId} />
    <div class="about">
      {#if person.preferredName}
        <p class="muted">{i18n.t('member.called', { name: person.preferredName })}</p>
      {/if}
      {#if person.city}<p class="muted">{person.city}</p>{/if}
      {#if person.bio}<p class="bio">{person.bio}</p>{/if}
    </div>
  </Card>

  <Card class="contact" aria-labelledby="contact-head">
    <h2 id="contact-head">{i18n.t('member.contact')}</h2>
    {#if contacts.length > 0}
      <dl>
        {#each contacts as contact (contact.label)}
          <div>
            <dt>{contact.label}</dt>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- tel:, mailto: and allow-listed https: links leave the app -->
            <dd><a href={contact.href} rel="noopener noreferrer">{contact.text}</a></dd>
          </div>
        {/each}
      </dl>
    {:else}
      <p class="muted">{i18n.t('member.nothingShared', { name: person.displayName })}</p>
    {/if}
    {#if data.self}
      <p class="muted">
        {i18n.t('member.you')} <a href={resolve('/profile')}>{i18n.t('member.edit')}</a>
      </p>
    {/if}
  </Card>
</div>

<style>
  .member-page {
    display: grid;
    gap: calc(var(--space-unit) * 4);
  }

  .member-page :global(.member) {
    display: flex;
    align-items: center;
    gap: calc(var(--space-unit) * 4);
    padding: calc(var(--space-unit) * 5);
  }

  .member-page :global(.contact) {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 5);
  }

  .about {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
    min-width: 0;
  }

  h2 {
    font: var(--text-heading);
  }

  .bio {
    white-space: pre-line;
    overflow-wrap: anywhere;
  }

  .muted {
    color: var(--color-muted);
    font-size: 0.9375rem;
  }

  dl {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    margin: 0;
  }

  dd {
    margin: 0;
  }

  dt {
    color: var(--color-muted);
    font: var(--text-small);
  }

  dd a,
  .back,
  .muted a {
    color: var(--color-accent);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
</style>
