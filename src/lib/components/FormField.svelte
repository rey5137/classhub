<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props {
    id: string;
    label: string;
    value?: string;
    placeholder?: string;
    type?: string;
    hint?: string;
    error?: string;
    multiline?: boolean;
    labelHidden?: boolean;
    /** The form field name; defaults to `id`. */
    name?: string;
    required?: boolean;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    maxlength?: number;
  }

  let {
    id,
    label,
    value = '',
    placeholder = '',
    type = 'text',
    hint,
    error,
    multiline = false,
    labelHidden = false,
    name,
    required = false,
    autocomplete,
    maxlength,
  }: Props = $props();

  const describedBy = $derived(
    [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined,
  );
</script>

<div class="field">
  <label for={id} class:visually-hidden={labelHidden}>{label}</label>
  {#if multiline}
    <textarea
      {id}
      name={name ?? id}
      {placeholder}
      {required}
      {maxlength}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      rows="3">{value}</textarea
    >
  {:else}
    <input
      {id}
      name={name ?? id}
      {type}
      {value}
      {placeholder}
      {required}
      {autocomplete}
      {maxlength}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
    />
  {/if}
  {#if hint}<p id="{id}-hint" class="hint">{hint}</p>{/if}
  {#if error}<p id="{id}-error" class="error">{error}</p>{/if}
</div>

<style>
  .field {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
    min-width: 0;
  }

  label {
    font-weight: 600;
    font-size: 0.875rem;
  }

  input,
  textarea {
    width: 100%;
    min-height: 44px;
    padding: calc(var(--space-unit) * 2.5) calc(var(--space-unit) * 3.5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }

  textarea {
    resize: vertical;
  }

  .hint {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .error {
    color: var(--color-danger);
    font-size: 0.875rem;
  }
</style>
