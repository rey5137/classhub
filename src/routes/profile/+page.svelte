<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import Avatar from '$lib/components/Avatar.svelte';
  import AvatarEditor from '$lib/components/AvatarEditor.svelte';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { ProfileField, Visibility } from '$lib/contracts/profile';
  import type { MessageKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import { mediumDate } from '$lib/shared/time';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const i18n = useI18n();

  type Editable = Exclude<ProfileField, 'avatar_media_id'>;
  interface FieldSpec {
    key: 'preferredName' | 'contactEmail' | 'phone' | 'messagingUrl' | 'city' | 'bio';
    label: MessageKey;
    hint?: MessageKey;
    invalid: MessageKey;
    type?: string;
    multiline?: boolean;
    max: number;
    autocomplete?: 'nickname' | 'email' | 'tel' | 'url' | 'address-level2' | 'off';
  }

  const specs: Record<Editable, FieldSpec> = {
    preferred_name: {
      key: 'preferredName',
      label: 'prof.preferredName',
      hint: 'prof.preferredNameHint',
      invalid: 'prof.invalid.text',
      max: 80,
      autocomplete: 'nickname',
    },
    bio: { key: 'bio', label: 'prof.bio', invalid: 'prof.invalid.text', multiline: true, max: 500 },
    contact_email: {
      key: 'contactEmail',
      label: 'prof.contactEmail',
      hint: 'prof.contactEmailHint',
      invalid: 'prof.invalid.contactEmail',
      type: 'email',
      max: 254,
      autocomplete: 'email',
    },
    phone: {
      key: 'phone',
      label: 'prof.phone',
      invalid: 'prof.invalid.phone',
      type: 'tel',
      max: 32,
      autocomplete: 'tel',
    },
    messaging_url: {
      key: 'messagingUrl',
      label: 'prof.messagingUrl',
      hint: 'prof.messagingUrlHint',
      invalid: 'prof.invalid.messagingUrl',
      type: 'url',
      max: 300,
      autocomplete: 'url',
    },
    city: {
      key: 'city',
      label: 'prof.city',
      invalid: 'prof.invalid.text',
      max: 80,
      autocomplete: 'address-level2',
    },
  };

  const shown = $derived(
    data.fields.filter((field): field is Editable => field !== 'avatar_media_id'),
  );
  const about = $derived(shown.filter((field) => field === 'preferred_name' || field === 'bio'));
  const contact = $derived(shown.filter((field) => field !== 'preferred_name' && field !== 'bio'));
  const levels: Visibility[] = ['private', 'admins', 'members'];

  function current(field: Editable): string {
    const profile = data.profile;
    const value = profile[specs[field].key];
    if (value === undefined) return '';
    return typeof value === 'string' ? value : value.text;
  }

  const fields = $derived(form && 'fields' in form ? (form.fields as Record<string, string>) : {});
  const fieldError = (key: string, invalid: MessageKey) =>
    form?.action === 'save' && key in fields ? i18n.t(invalid) : undefined;
  const notice = $derived(
    form && 'done' in form && form.done
      ? i18n.t(
          (
            {
              saved: 'prof.saved',
              cleared: 'prof.cleared',
              requested: 'prof.deleteRequested',
              avatarRemoved: 'prof.avatar.removed',
            } as const
          )[form.done as 'saved'],
        )
      : null,
  );
  const failure = $derived(form && 'message' in form ? form.message : null);
  // Set by the avatar editor, which saves outside the form actions; any later action result replaces it.
  let avatarSaved = $state(false);
  $effect(() => {
    void form;
    avatarSaved = false;
  });

  // R-UI-11: in the viewer's time zone, the same as every other date on the page.
  const formatDate = (at: number | Date) => mediumDate(at, i18n.locale, data.timeZone);

  // Keep what the member typed when the server refuses it.
  const keep: SubmitFunction =
    () =>
    async ({ update }) =>
      update({ reset: false });
</script>

<PageHeader title={i18n.t('prof.title')} lede={i18n.t('prof.lede')} />

<p class="install-link">
  <a href={resolve('/install')}>{i18n.t('install.profileLink')}</a>
  {#if data.features.notifications}
    <span aria-hidden="true">·</span>
    <a href={resolve('/notifications')}>{i18n.t('profile.notificationsLink')}</a>
  {/if}
</p>

{#snippet visibilityFor(field: Editable)}
  <div class="visibility">
    <label for="visibility-{field}">{i18n.t('prof.visibility')}</label>
    <select
      id="visibility-{field}"
      name="visibility.{field}"
      aria-label={i18n.t('prof.visibilityFor', { field: i18n.t(specs[field].label) })}
    >
      {#each levels as level (level)}
        <option value={level} selected={data.visibility[field] === level}>
          {i18n.t(`prof.visibility.${level}`)}
        </option>
      {/each}
    </select>
  </div>
{/snippet}

{#snippet row(field: Editable)}
  {@const spec = specs[field]}
  <div class="row">
    <FormField
      id="profile-{field}"
      name={field}
      label={i18n.t(spec.label)}
      value={current(field)}
      type={spec.type ?? 'text'}
      multiline={spec.multiline ?? false}
      maxlength={spec.max}
      autocomplete={spec.autocomplete ?? 'off'}
      {...spec.hint ? { hint: i18n.t(spec.hint) } : {}}
      error={fieldError(spec.key, spec.invalid)}
    />
    {@render visibilityFor(field)}
  </div>
{/snippet}

<div class="profile-page">
  {#if avatarSaved}<Banner>{i18n.t('prof.avatar.saved')}</Banner>
  {:else if notice}<Banner>{notice}</Banner>{/if}
  {#if failure}<Banner tone="danger">{failure}</Banner>{/if}
  {#if data.deletionRequestedAt !== null}
    <Banner tone="warning">
      {i18n.t('prof.deletePending', { date: formatDate(data.deletionRequestedAt) })}
    </Banner>
  {/if}

  <form method="POST" action="?/save" use:enhance={keep} class="stack">
    <Card class="sheet" aria-labelledby="about-head">
      <h2 id="about-head">{i18n.t('prof.section.about')}</h2>
      <div class="identity">
        <div class="picture">
          <Avatar name={data.profile.displayName} size="lg" mediaId={data.profile.avatarMediaId} />
          <AvatarEditor
            hasAvatar={Boolean(data.profile.avatarMediaId)}
            onsaved={() => (avatarSaved = true)}
          />
          {#if data.profile.avatarMediaId}
            <!-- R-PROF-10: the picture alone, through its own form, so Enter in a field never removes it. -->
            <Button type="submit" variant="ghost" form="avatar-remove">
              {i18n.t('prof.avatar.remove')}
            </Button>
          {/if}
        </div>
        <div class="fields">
          <FormField
            id="profile-name"
            name="displayName"
            label={i18n.t('prof.name')}
            value={data.profile.displayName}
            maxlength={80}
            autocomplete="name"
            required
            error={fieldError('displayName', 'prof.invalid.text')}
          />
          {#each about as field (field)}
            {@render row(field)}
          {/each}
        </div>
      </div>
    </Card>

    {#if contact.length > 0}
      <Card class="sheet" aria-labelledby="contact-head">
        <h2 id="contact-head">{i18n.t('prof.section.contact')}</h2>
        <p class="muted">{i18n.t('prof.section.contactLede')}</p>
        <div class="fields">
          {#each contact as field (field)}
            {@render row(field)}
          {/each}
        </div>
      </Card>
    {/if}

    <div class="actions">
      <Button type="submit" variant="primary">{i18n.t('prof.save')}</Button>
    </div>
  </form>
  <form id="avatar-remove" method="POST" action="?/removeAvatar" use:enhance hidden></form>

  <Card class="sheet" aria-labelledby="data-head">
    <h2 id="data-head">{i18n.t('prof.section.data')}</h2>
    <div class="task">
      <p class="muted">{i18n.t('prof.exportHint')}</p>
      <a class="download" href={resolve('/api/v1/me/export')} download>{i18n.t('prof.export')}</a>
    </div>
    <!-- Each irreversible action opens a confirmation first; <details> needs no script. -->
    <details class="task">
      <summary>{i18n.t('prof.clear')}</summary>
      <form method="POST" action="?/clear" use:enhance class="confirm">
        <p class="muted">{i18n.t('prof.clearHint')}</p>
        <Button type="submit" variant="primary">{i18n.t('prof.clearConfirm')}</Button>
      </form>
    </details>
    {#if data.deletionRequestedAt === null}
      <details class="task">
        <summary>{i18n.t('prof.delete')}</summary>
        <form method="POST" action="?/deletion" use:enhance class="confirm">
          <p class="muted">{i18n.t('prof.deleteHint')}</p>
          <fieldset>
            <legend>{i18n.t('prof.deleteChoice')}</legend>
            <label
              ><input type="radio" name="keepContent" value="keep" checked />
              {i18n.t('prof.deleteKeep')}</label
            >
            <label
              ><input type="radio" name="keepContent" value="delete" />
              {i18n.t('prof.deleteRemove')}</label
            >
          </fieldset>
          <Button type="submit" variant="primary">{i18n.t('prof.deleteConfirm')}</Button>
        </form>
      </details>
    {/if}
    <p class="privacy">{i18n.t('prof.privacy')}</p>
  </Card>
</div>

<style>
  .install-link {
    margin: 0 0 calc(var(--space-unit) * 4);
  }
  .install-link a {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
  }

  .profile-page,
  .stack {
    display: grid;
    gap: calc(var(--space-unit) * 4);
  }

  .profile-page :global(.sheet) {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    padding: calc(var(--space-unit) * 5);
  }

  h2 {
    font: var(--text-heading);
  }

  .identity {
    display: grid;
    gap: calc(var(--space-unit) * 4);
  }

  .picture {
    display: grid;
    justify-items: start;
    gap: calc(var(--space-unit) * 2);
  }

  @media (min-width: 768px) {
    .identity {
      grid-template-columns: auto 1fr;
      align-items: start;
    }
  }

  .fields {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    max-width: 44rem;
    min-width: 0;
  }

  .row {
    display: grid;
    gap: calc(var(--space-unit) * 2);
    min-width: 0;
  }

  @media (min-width: 640px) {
    .row {
      grid-template-columns: minmax(0, 1fr) 11rem;
      align-items: start;
    }
  }

  /* Matches FormField, so the select lines up with the field beside it. */
  .visibility {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
  }

  .visibility label,
  legend {
    font-weight: 600;
    font-size: 0.875rem;
  }

  select {
    min-height: 48px;
    padding: 0 calc(var(--space-unit) * 3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }

  .muted,
  .privacy {
    color: var(--color-muted);
    font: var(--text-small);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2);
  }

  .task {
    display: grid;
    gap: calc(var(--space-unit) * 2);
    justify-items: start;
    padding-top: calc(var(--space-unit) * 4);
    border-top: 1px solid var(--color-divider);
  }

  details.task {
    display: block;
  }

  summary {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font-weight: 600;
    cursor: pointer;
  }

  .confirm {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    justify-items: start;
    margin-top: calc(var(--space-unit) * 3);
  }

  fieldset {
    display: grid;
    gap: calc(var(--space-unit) * 2);
    border: 0;
    padding: 0;
    margin: 0;
  }

  fieldset label {
    display: flex;
    gap: calc(var(--space-unit) * 2);
    align-items: center;
    min-height: 44px;
  }

  .download {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--color-accent);
    font-weight: 600;
  }

  .privacy {
    padding-top: calc(var(--space-unit) * 4);
    border-top: 1px solid var(--color-divider);
  }
</style>
