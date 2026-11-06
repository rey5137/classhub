<script lang="ts">
  interface Props {
    /** HTML from the server's Markdown renderer only (R-BRD-03): allow-listed tags, safe links. */
    html: string;
  }

  let { html }: Props = $props();
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized server-side by renderMarkdown (AC-BRD-01), never stored -->
<div class="markdown">{@html html}</div>

<style>
  .markdown {
    font: var(--text-body);
    color: var(--color-text);
    overflow-wrap: anywhere;
  }

  .markdown :global(:where(p, ul, ol, blockquote, h3)) {
    margin: 0 0 calc(var(--space-unit) * 3);
  }

  .markdown :global(:where(p, ul, ol, blockquote, h3):last-child) {
    margin-bottom: 0;
  }

  .markdown :global(:where(ul, ol)) {
    padding-left: calc(var(--space-unit) * 6);
  }

  .markdown :global(h3) {
    font: var(--text-heading);
  }

  .markdown :global(a) {
    color: var(--color-accent);
    text-decoration: underline;
  }

  .markdown :global(blockquote) {
    padding-left: calc(var(--space-unit) * 3);
    border-left: 3px solid var(--color-divider);
    color: var(--color-muted);
  }

  .markdown :global(code) {
    padding: 0 calc(var(--space-unit) * 1);
    border-radius: var(--radius-control);
    background: var(--color-surface-2);
    font-size: 0.9375em;
  }

  .markdown :global(img) {
    display: block;
    max-width: min(100%, 320px);
    height: auto;
    border-radius: var(--radius-control);
  }
</style>
