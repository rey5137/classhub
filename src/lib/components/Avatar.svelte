<script lang="ts">
  interface Props {
    name: string;
    size?: 'sm' | 'md' | 'lg';
    tone?: number;
    showInitials?: boolean;
    /** The 512 px avatar picture, present only when the projection shows it (R-PROF-04, 13). */
    mediaId?: string;
  }

  let { name, size = 'md', tone, showInitials = true, mediaId }: Props = $props();

  const initials = $derived(
    name
      .trim()
      .split(/\s+/)
      .map((word) => word[0] ?? '')
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );
</script>

<span
  class="avatar {size}"
  style:--avatar-bg={tone === undefined ? undefined : `var(--avatar-${(tone % 10) + 1})`}
  style:--avatar-fg={tone === undefined ? undefined : 'var(--avatar-ink)'}
  aria-hidden="true"
  data-initials={!mediaId && showInitials ? initials : undefined}
  >{#if mediaId}<img
      src="/api/v1/media/{mediaId}/image"
      alt=""
      loading="lazy"
      decoding="async"
    />{/if}</span
>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    border-radius: 50%;
    background: var(--avatar-bg, var(--color-surface-2));
    color: var(--avatar-fg, var(--color-accent));
    font-weight: 700;
    line-height: 1;
    overflow: hidden;
  }

  /* Drawn, not text: the picture is decorative, and a labelled control holding it (the account button) keeps
     its own name (axe label-content-name-mismatch). */
  [data-initials]::before {
    content: attr(data-initials);
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .sm {
    width: calc(var(--space-unit) * 7);
    height: calc(var(--space-unit) * 7);
    font-size: 0.75rem;
  }

  .md {
    width: calc(var(--space-unit) * 10);
    height: calc(var(--space-unit) * 10);
    font-size: 0.875rem;
  }

  .lg {
    width: calc(var(--space-unit) * 22);
    height: calc(var(--space-unit) * 22);
    font-size: 1.25rem;
  }
</style>
