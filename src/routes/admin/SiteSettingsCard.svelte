<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import UploadSheet from '$lib/components/UploadSheet.svelte';
  import type { SiteSettings } from '$lib/contracts/settings';
  import type { MessageKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';

  type MediaKey = 'bannerMediaId' | 'logoMediaId' | 'faviconMediaId';

  interface Props {
    settings: SiteSettings;
    themes: { id: SiteSettings['theme']; modes: ('light' | 'dark')[] }[];
    /** The page's last form result, when it came from the settings form. */
    form: { action?: string; fields?: Record<string, string> } | null;
  }

  let { settings, themes, form }: Props = $props();
  const i18n = useI18n();

  // The accent boxes follow the theme picked in the form, before it is saved.
  // svelte-ignore state_referenced_locally
  let theme = $state(settings.theme);
  const shipped = $derived(themes.find((entry) => entry.id === theme)?.modes ?? []);

  const pictures: { key: MediaKey; label: MessageKey; hint: MessageKey }[] = [
    { key: 'bannerMediaId', label: 'admin.settings.banner', hint: 'admin.settings.bannerHint' },
    { key: 'logoMediaId', label: 'admin.settings.logo', hint: 'admin.settings.logoHint' },
    { key: 'faviconMediaId', label: 'admin.settings.favicon', hint: 'admin.settings.faviconHint' },
  ];
  let uploading = $state<MediaKey | null>(null);
  // Each button names its picture, so a screen reader's list reads "Remove: Logo".
  const labelFor = (action: MessageKey, picture: MessageKey) =>
    i18n.t('admin.actionFor', { action: i18n.t(action), name: i18n.t(picture) });
  let pictureProblem = $state<string | null>(null);

  // R-UI-04: the contrast refusal carries its measured ratio; say it in the reader's language.
  function fieldError(name: string): string | undefined {
    if (form?.action !== 'settings') return undefined;
    const value = form.fields?.[name];
    if (!value) return undefined;
    const ratio = /(\d+\.\d\d):1/.exec(value)?.[1];
    if (ratio) return i18n.t('admin.settings.accentLow', { ratio });
    if (/has no (light|dark) mode/.test(value)) return i18n.t('admin.settings.accentMode');
    if (value === 'not_found') return i18n.t('admin.settings.pictureGone');
    return i18n.t('error.validation');
  }

  const featuresError = $derived(
    ['features', 'features.memories', 'features.discussions', 'features.chat', 'features.join']
      .map(fieldError)
      .find(Boolean),
  );

  // WCAG 3.3.1: a control names its hint and, when there is one, its error.
  const describedBy = (...ids: (string | false | undefined)[]) =>
    ids.filter(Boolean).join(' ') || undefined;

  // An upload is saved at once, so the previous picture is retired with it (R-UI-01).
  async function uploaded(key: MediaKey, mediaId: string) {
    pictureProblem = null;
    const response = await fetch('/api/v1/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: mediaId }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response?.ok) {
      pictureProblem = i18n.t('admin.settings.pictureFailed');
      // Not linked, so nothing shows it: remove it now. Housekeeping retires it after a
      // day if this fails too (R-UI-01).
      await fetch(`/api/v1/media/${mediaId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
    }
    await invalidateAll();
  }
</script>

<Card class="sheet" aria-labelledby="settings-head">
  <div class="head">
    <h2 id="settings-head">{i18n.t('admin.settings')}</h2>
  </div>

  <!-- No `use:enhance`: a plain POST renders the page again in the theme just saved. -->
  <form method="POST" action="?/settings" class="settings">
    <fieldset>
      <legend>{i18n.t('admin.settings.class')}</legend>
      <FormField
        id="settings-name"
        name="name"
        label={i18n.t('admin.settings.name')}
        value={settings.name}
        maxlength={80}
        required
        error={fieldError('name')}
      />
      <FormField
        id="settings-years"
        name="years"
        label={i18n.t('admin.settings.years')}
        value={settings.years}
        maxlength={40}
        required
        error={fieldError('years')}
      />
      <FormField
        id="settings-description"
        name="description"
        label={i18n.t('admin.settings.description')}
        value={settings.description}
        maxlength={300}
        multiline
        error={fieldError('description')}
      />
      <FormField
        id="settings-welcome"
        name="welcome"
        label={i18n.t('admin.settings.welcome')}
        hint={i18n.t('admin.settings.welcomeHint')}
        value={settings.welcome}
        maxlength={2000}
        multiline
        error={fieldError('welcome')}
      />
    </fieldset>

    <fieldset aria-describedby={describedBy(!!fieldError('theme') && 'settings-theme-error')}>
      <legend>{i18n.t('admin.theme')}</legend>
      <div class="choices themes">
        {#each themes as option (option.id)}
          <label class="choice">
            <input type="radio" name="theme" value={option.id} bind:group={theme} />
            <span
              class="swatch"
              data-theme={option.id}
              data-mode={option.modes[0]}
              aria-hidden="true"
            >
              <span class="sample">
                <b>Aa</b>
                <i></i>
              </span>
            </span>
            {i18n.t(`admin.settings.theme.${option.id}`)}
          </label>
        {/each}
      </div>
      {#if fieldError('theme')}
        <p id="settings-theme-error" class="error">{fieldError('theme')}</p>
      {/if}
    </fieldset>

    <fieldset
      aria-describedby={describedBy(
        'settings-mode-hint',
        !!fieldError('mode') && 'settings-mode-error',
      )}
    >
      <legend>{i18n.t('admin.settings.mode')}</legend>
      <div class="choices">
        {#each ['light', 'dark', 'system'] as const as mode (mode)}
          <label class="choice">
            <input type="radio" name="mode" value={mode} checked={settings.mode === mode} />
            {i18n.t(`admin.settings.mode.${mode}`)}
          </label>
        {/each}
      </div>
      <p id="settings-mode-hint" class="hint">{i18n.t('admin.settings.modeHint')}</p>
      {#if fieldError('mode')}
        <p id="settings-mode-error" class="error">{fieldError('mode')}</p>
      {/if}
    </fieldset>

    <fieldset>
      <legend>{i18n.t('admin.settings.accent')}</legend>
      <p class="hint">{i18n.t('admin.settings.accentHint')}</p>
      <div class="pair">
        {#each shipped as mode (mode)}
          <FormField
            id="settings-accent-{mode}"
            name="accent-{mode}"
            label={i18n.t(`admin.settings.accent.${mode}`)}
            value={settings.accent?.[mode] ?? ''}
            maxlength={7}
            autocomplete="off"
            error={fieldError(`accent.${mode}`)}
          />
        {/each}
      </div>
    </fieldset>

    <fieldset aria-describedby={describedBy(!!fieldError('density') && 'settings-density-error')}>
      <legend>{i18n.t('admin.settings.density')}</legend>
      <div class="choices">
        {#each ['comfortable', 'compact'] as const as density (density)}
          <label class="choice">
            <input
              type="radio"
              name="density"
              value={density}
              checked={settings.density === density}
            />
            {i18n.t(`admin.settings.density.${density}`)}
          </label>
        {/each}
      </div>
      {#if fieldError('density')}
        <p id="settings-density-error" class="error">{fieldError('density')}</p>
      {/if}
    </fieldset>

    <div class="field">
      <label for="settings-locale">{i18n.t('admin.settings.locale')}</label>
      <select
        id="settings-locale"
        name="locale"
        aria-invalid={fieldError('locale') ? 'true' : undefined}
        aria-describedby={describedBy(
          'settings-locale-hint',
          !!fieldError('locale') && 'settings-locale-error',
        )}
      >
        <option value="vi" selected={settings.locale === 'vi'}>Tiếng Việt</option>
        <option value="en" selected={settings.locale === 'en'}>English</option>
      </select>
      <p id="settings-locale-hint" class="hint">{i18n.t('admin.settings.localeHint')}</p>
      {#if fieldError('locale')}
        <p id="settings-locale-error" class="error">{fieldError('locale')}</p>
      {/if}
    </div>

    <fieldset
      aria-describedby={describedBy(
        'settings-features-hint',
        !!featuresError && 'settings-features-error',
      )}
    >
      <legend>{i18n.t('admin.settings.features')}</legend>
      <div class="choices">
        {#each ['memories', 'discussions', 'chat'] as const as feature (feature)}
          <label class="choice">
            <input type="checkbox" name={feature} checked={settings.features[feature]} />
            <input
              type="hidden"
              name="was-{feature}"
              value={settings.features[feature] ? 'on' : ''}
            />
            {i18n.t(`nav.${feature}`)}
          </label>
        {/each}
      </div>
      <p id="settings-features-hint" class="hint">{i18n.t('admin.settings.featuresHint')}</p>
      {#if featuresError}
        <p id="settings-features-error" class="error">{featuresError}</p>
      {/if}
    </fieldset>

    <!-- R-AUTH-27: the public /join form; off by default. -->
    <div class="field">
      <label class="choice">
        <input
          type="checkbox"
          name="join"
          checked={settings.features.join}
          aria-describedby="settings-join-hint"
        />
        <input type="hidden" name="was-join" value={settings.features.join ? 'on' : ''} />
        {i18n.t('admin.settings.join')}
      </label>
      <p id="settings-join-hint" class="hint">{i18n.t('admin.settings.joinHint')}</p>
    </div>

    <div>
      <Button type="submit" variant="primary">{i18n.t('admin.settings.save')}</Button>
    </div>
  </form>

  <section class="pictures" aria-labelledby="pictures-head">
    <h3 id="pictures-head">{i18n.t('admin.settings.pictures')}</h3>
    {#if pictureProblem}
      <Banner tone="danger">{pictureProblem}</Banner>
    {/if}
    <ul>
      {#each pictures as picture (picture.key)}
        {@const current = settings[picture.key]}
        {@const error = fieldError(picture.key)}
        {@const described = describedBy(`${picture.key}-hint`, !!error && `${picture.key}-error`)}
        <li class="picture">
          <div class="preview">
            {#if current}
              <img src="/api/v1/media/{current}/thumb" alt="" />
            {:else}
              <span class="none" aria-hidden="true"></span>
            {/if}
          </div>
          <div class="about">
            <p class="name">{i18n.t(picture.label)}</p>
            <p class="hint" id="{picture.key}-hint">
              {current ? i18n.t(picture.hint) : i18n.t('admin.settings.pictureNone')}
            </p>
            {#if error}
              <p class="error" id="{picture.key}-error">{error}</p>
            {/if}
          </div>
          <div class="actions">
            <Button
              type="button"
              variant="ghost"
              aria-label={labelFor(
                current ? 'admin.settings.pictureReplace' : 'admin.settings.pictureUpload',
                picture.label,
              )}
              aria-describedby={described}
              onclick={() => (uploading = picture.key)}
            >
              {i18n.t(current ? 'admin.settings.pictureReplace' : 'admin.settings.pictureUpload')}
            </Button>
            {#if current}
              <form method="POST" action="?/settingsMedia">
                <input type="hidden" name="remove" value={picture.key} />
                <Button
                  type="submit"
                  variant="ghost"
                  aria-label={labelFor('admin.settings.pictureRemove', picture.label)}
                  aria-describedby={described}
                >
                  {i18n.t('admin.settings.pictureRemove')}
                </Button>
              </form>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </section>
</Card>

<UploadSheet
  open={uploading !== null}
  purpose="site"
  title={uploading ? i18n.t(pictures.find((p) => p.key === uploading)!.label) : ''}
  onuploaded={(id) => {
    if (uploading) void uploaded(uploading, id);
  }}
  onclose={() => (uploading = null)}
/>

<style>
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  h2 {
    font: var(--text-heading);
  }

  h3 {
    font-weight: 600;
  }

  .settings {
    display: grid;
    gap: calc(var(--space-unit) * 5);
    max-width: 44rem;
  }

  fieldset {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    margin-bottom: calc(var(--space-unit) * 2);
    padding: 0;
    font-weight: 600;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2) calc(var(--space-unit) * 5);
  }

  .choice {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--space-unit) * 2);
    min-height: 44px;
  }

  .choice input {
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--color-accent);
  }

  /* A small preview of the theme itself: its page, a card on it, its heading face and its accent. */
  .swatch {
    display: inline-grid;
    place-items: center;
    width: 64px;
    height: 44px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-bg);
  }

  .sample {
    display: grid;
    gap: 3px;
    width: 44px;
    padding: 3px 5px 5px;
    border: 1px solid var(--color-divider);
    border-radius: 4px;
    background: var(--color-surface);
  }

  .sample b {
    color: var(--color-text);
    font: 400 0.875rem / 1 var(--font-heading);
  }

  .sample i {
    height: 5px;
    border-radius: 2px;
    background: var(--color-accent);
  }

  .pair {
    display: grid;
    gap: calc(var(--space-unit) * 3);
  }

  @media (min-width: 768px) {
    .pair {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .field {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
    min-width: 0;
    max-width: 20rem;
  }

  .field label {
    font-weight: 600;
    font-size: 0.875rem;
  }

  select {
    min-height: 44px;
    padding: 0 calc(var(--space-unit) * 3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }

  .hint {
    color: var(--color-muted);
    font: var(--text-small);
  }

  .error {
    color: var(--color-danger);
    font: var(--text-small);
    font-weight: 600;
  }

  .pictures {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    padding-top: calc(var(--space-unit) * 4);
    border-top: 1px solid var(--color-divider);
  }

  .pictures ul {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .picture {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: calc(var(--space-unit) * 3);
    padding: calc(var(--space-unit) * 3) 0;
    border-top: 1px solid var(--color-divider);
  }

  .preview img,
  .none {
    display: block;
    width: 56px;
    height: 56px;
    border-radius: var(--radius-control);
    object-fit: cover;
  }

  .none {
    border: 1px dashed var(--color-border);
    background: var(--color-surface-2);
  }

  .about {
    flex: 1 1 12rem;
    min-width: 0;
  }

  .name {
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 1);
  }
</style>
