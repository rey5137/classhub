<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { MessageKey } from '$lib/i18n';

  interface InfoRow {
    id: string;
    slug: string;
    title: string;
    bodyMd: string;
    isPinned: boolean;
    sortOrder: number;
  }

  interface Props {
    pages: InfoRow[];
    /** The page's last form result, when it came from one of these forms. */
    form: { action?: string; target?: string; fields?: Record<string, string> } | null;
  }

  let { pages, form }: Props = $props();
  const i18n = useI18n();

  // R-BRD-02: each editor and the create form show only their own field errors.
  function fieldError(action: string, name: string, target?: string): string | undefined {
    if (form?.action !== action || (target && form.target !== target)) return undefined;
    const code = form.fields?.[name];
    if (!code) return undefined;
    return i18n.t(code === 'taken' ? 'info.error.slug_taken' : 'error.validation');
  }

  const labelFor = (action: MessageKey, page: InfoRow) =>
    i18n.t('admin.actionFor', { action: i18n.t(action), name: page.title });
</script>

{#snippet fields(prefix: string, action: string, page?: InfoRow)}
  <FormField
    id="{prefix}-title"
    name="title"
    label={i18n.t('admin.info.pageTitle')}
    value={page?.title ?? ''}
    maxlength={160}
    required
    error={fieldError(action, 'title', page?.id)}
  />
  <FormField
    id="{prefix}-slug"
    name="slug"
    label={i18n.t('admin.info.slug')}
    hint={i18n.t('admin.info.slugHint')}
    value={page?.slug ?? ''}
    maxlength={40}
    autocomplete="off"
    required
    error={fieldError(action, 'slug', page?.id)}
  />
  <FormField
    id="{prefix}-body"
    name="body"
    label={i18n.t('admin.info.body')}
    hint={i18n.t('admin.info.bodyHint')}
    value={page?.bodyMd ?? ''}
    maxlength={20000}
    multiline
    error={fieldError(action, 'body', page?.id)}
  />
  <div class="row">
    <label class="check">
      <input type="checkbox" name="isPinned" checked={page?.isPinned ?? false} />
      {i18n.t('admin.info.pinned')}
    </label>
    <FormField
      id="{prefix}-order"
      name="sortOrder"
      type="number"
      inputmode="numeric"
      label={i18n.t('admin.info.sortOrder')}
      value={String(page?.sortOrder ?? 0)}
      error={fieldError(action, 'sortOrder', page?.id)}
    />
  </div>
{/snippet}

<Card class="sheet" aria-labelledby="info-head">
  <div class="head">
    <h2 id="info-head">{i18n.t('admin.info')}</h2>
  </div>
  <p class="hint">{i18n.t('admin.info.hint')}</p>

  {#if pages.length === 0}
    <p class="muted">{i18n.t('admin.info.empty')}</p>
  {:else}
    <ul class="pages">
      {#each pages as page (page.id)}
        <li class="page">
          <div class="who">
            <p class="name">
              <a href={resolve('/info/[slug]', { slug: page.slug })}>{page.title}</a>
            </p>
            <p class="meta">
              <span class="tnum">/info/{page.slug}</span>
              {#if page.isPinned}<span class="pin">{i18n.t('admin.info.pinnedBadge')}</span>{/if}
              <span class="tnum">{i18n.t('admin.info.order', { order: page.sortOrder })}</span>
            </p>
          </div>
          <div class="tasks">
            <details
              class="task"
              open={form?.action === 'infoEdit' && form.target === page.id ? true : undefined}
            >
              <summary aria-label={labelFor('admin.info.edit', page)}
                >{i18n.t('admin.info.edit')}</summary
              >
              <form method="POST" action="?/infoEdit" class="editor" use:enhance>
                <input type="hidden" name="id" value={page.id} />
                {@render fields(`info-${page.id}`, 'infoEdit', page)}
                <Button type="submit" variant="primary">{i18n.t('admin.info.save')}</Button>
              </form>
            </details>
            <!-- R-BRD-02: a hard delete, so it asks once more; <details> needs no script. -->
            <details class="task">
              <summary aria-label={labelFor('admin.info.delete', page)}
                >{i18n.t('admin.info.delete')}</summary
              >
              <form method="POST" action="?/infoDelete" class="editor" use:enhance>
                <input type="hidden" name="id" value={page.id} />
                <p class="muted">{i18n.t('admin.info.deleteHint')}</p>
                <Button type="submit" variant="primary">{i18n.t('admin.info.deleteConfirm')}</Button
                >
              </form>
            </details>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <details class="task" open={form?.action === 'infoCreate' ? true : undefined}>
    <summary>{i18n.t('admin.info.new')}</summary>
    <form method="POST" action="?/infoCreate" class="editor" use:enhance>
      {@render fields('info-new', 'infoCreate')}
      <Button type="submit" variant="primary">{i18n.t('admin.info.create')}</Button>
    </form>
  </details>
</Card>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: calc(var(--space-unit) * 2);
  }

  h2 {
    font: var(--text-heading);
  }

  .hint {
    margin-top: calc(var(--space-unit) * -2);
    color: var(--color-muted);
    font: var(--text-small);
  }

  .muted {
    color: var(--color-muted);
  }

  .pages {
    display: grid;
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .page {
    display: grid;
    gap: calc(var(--space-unit) * 2);
    padding: calc(var(--space-unit) * 3) 0;
    border-top: 1px solid var(--color-divider);
  }

  .who {
    display: grid;
    gap: calc(var(--space-unit) * 0.5);
    min-width: 0;
  }

  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .name a {
    color: var(--color-accent);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 1) calc(var(--space-unit) * 3);
    color: var(--color-muted);
    font: var(--text-small);
    overflow-wrap: anywhere;
  }

  .pin {
    color: var(--color-accent);
    font-weight: 600;
  }

  .tasks {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: calc(var(--space-unit) * 2);
  }

  /* An open editor takes the row's width; the other button wraps below it. */
  .tasks details[open] {
    flex-basis: 100%;
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

  .editor {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    justify-items: start;
    max-width: 40rem;
    margin-top: calc(var(--space-unit) * 3);
  }

  .editor :global(.field) {
    justify-self: stretch;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: calc(var(--space-unit) * 4);
    justify-self: stretch;
  }

  .row :global(.field) {
    width: 8rem;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--space-unit) * 2);
    min-height: 44px;
    font-weight: 600;
  }

  .check input {
    width: 20px;
    height: 20px;
    accent-color: var(--color-accent);
  }
</style>
