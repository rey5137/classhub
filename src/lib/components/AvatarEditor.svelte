<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { Encoded } from '$lib/client/image/encode';
  import { cropCenter, IMAGE_ACCEPT, MAX_ZOOM, squareCrop } from '$lib/client/image/policy';
  import { setAvatar, UploadError, uploadEncoded } from '$lib/client/upload';
  import type { MessageKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import Banner from './Banner.svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';

  // R-MEM-13: the member picks a square of their picture, sees the exact 512 px copy
  // that will be stored (R-MEM-04), and only then uploads it and points the profile at it.

  interface Props {
    hasAvatar: boolean;
    onsaved?: () => void;
  }

  let { hasAvatar, onsaved }: Props = $props();
  const i18n = useI18n();

  type Step = 'idle' | 'preparing' | 'crop' | 'encoding' | 'confirm' | 'saving';
  let step = $state<Step>('idle');
  let file = $state<File | null>(null);
  let source = $state<{ url: string; width: number; height: number } | null>(null);
  // `mediaId` once the square is stored, so a retry after a refused PATCH only repeats the PATCH.
  let result = $state<{ encoded: Encoded; url: string; mediaId?: string } | null>(null);
  let zoom = $state(1);
  let centerX = $state(0.5);
  let centerY = $state(0.5);
  let problem = $state<string | null>(null);
  let input: HTMLInputElement;
  let frame = $state<HTMLButtonElement>();
  // Bumped by close(): an encode or save still running from before is dropped when it ends.
  let run = 0;

  const crop = $derived(
    source ? squareCrop(source.width, source.height, zoom, centerX, centerY) : null,
  );
  const open = $derived(step !== 'idle');

  function release() {
    if (source) URL.revokeObjectURL(source.url);
    if (result) URL.revokeObjectURL(result.url);
    source = null;
    result = null;
  }

  onDestroy(release);

  /** Moves the centre and keeps it where the clamped square really sits. */
  function place(x: number, y: number, nextZoom = zoom) {
    if (!source) return;
    zoom = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    const placed = squareCrop(source.width, source.height, zoom, x, y);
    ({ centerX, centerY } = cropCenter(source.width, source.height, placed));
  }

  function fail(key: MessageKey, params?: Record<string, string>) {
    problem = i18n.t(key, params);
  }

  async function picked() {
    const chosen = input.files?.[0];
    input.value = '';
    if (!chosen) return;
    release();
    file = chosen;
    problem = null;
    zoom = 1;
    centerX = 0.5;
    centerY = 0.5;
    step = 'preparing';
    const mine = run;
    const { prepareImage, EncodeRefusal } = await import('$lib/client/image/client');
    if (mine !== run) return;
    try {
      // A scaled copy to crop on; HEIC included, since the browser decoded it (R-MEM-01).
      const copy = await prepareImage(chosen, { kind: 'preview', edge: 1024 });
      if (mine !== run) return;
      source = { url: URL.createObjectURL(copy.image), width: copy.width, height: copy.height };
      step = 'crop';
    } catch (error) {
      if (mine !== run) return;
      const reason = error instanceof EncodeRefusal ? error.reason : 'undecodable';
      fail(`image.refused.${reason}` as MessageKey, { name: chosen.name });
      step = 'crop';
    }
  }

  async function preview() {
    if (!file) return;
    step = 'encoding';
    problem = null;
    const mine = run;
    const { prepareImage, EncodeRefusal } = await import('$lib/client/image/client');
    if (mine !== run) return;
    try {
      const encoded = await prepareImage(file, { kind: 'avatar', zoom, centerX, centerY });
      if (mine !== run) return;
      result = { encoded, url: URL.createObjectURL(encoded.image) };
      step = 'confirm';
    } catch (error) {
      if (mine !== run || !file) return;
      const reason = error instanceof EncodeRefusal ? error.reason : 'undecodable';
      fail(`image.refused.${reason}` as MessageKey, { name: file.name });
      step = 'crop';
    }
  }

  function back() {
    if (result) URL.revokeObjectURL(result.url);
    result = null;
    step = 'crop';
  }

  async function save() {
    const current = result;
    if (!current) return;
    const mine = run;
    step = 'saving';
    problem = null;
    try {
      current.mediaId ??= await uploadEncoded(current.encoded, 'avatar', {});
      await setAvatar(current.mediaId);
      if (mine === run) close();
      await invalidateAll();
      onsaved?.();
    } catch (error) {
      if (mine !== run) return;
      fail(`upload.error.${error instanceof UploadError ? error.code : 'internal'}`);
      step = 'confirm';
    }
  }

  function close() {
    run += 1;
    release();
    file = null;
    step = 'idle';
  }

  const STEP = 0.05;
  function keydown(event: KeyboardEvent) {
    if (!crop || !source) return;
    const moveX = (STEP * crop.size) / source.width;
    const moveY = (STEP * crop.size) / source.height;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => place(centerX - moveX, centerY),
      ArrowRight: () => place(centerX + moveX, centerY),
      ArrowUp: () => place(centerX, centerY - moveY),
      ArrowDown: () => place(centerX, centerY + moveY),
      '+': () => place(centerX, centerY, zoom + 0.25),
      '=': () => place(centerX, centerY, zoom + 0.25),
      '-': () => place(centerX, centerY, zoom - 0.25),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  }

  let drag: { x: number; y: number; centerX: number; centerY: number } | null = null;
  function pointerdown(event: PointerEvent) {
    drag = { x: event.clientX, y: event.clientY, centerX, centerY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function pointermove(event: PointerEvent) {
    if (!drag || !crop || !source || !frame) return;
    // A pixel of the frame is crop.size / frame width pixels of the copy; the picture follows the pointer.
    const scale = crop.size / frame.clientWidth;
    place(
      drag.centerX - ((event.clientX - drag.x) * scale) / source.width,
      drag.centerY - ((event.clientY - drag.y) * scale) / source.height,
    );
  }
  const pointerup = () => (drag = null);
</script>

<div class="trigger">
  <input
    bind:this={input}
    id="avatar-file"
    class="visually-hidden"
    type="file"
    accept={IMAGE_ACCEPT}
    tabindex="-1"
    aria-hidden="true"
    onchange={picked}
  />
  <Button type="button" onclick={() => input.click()}>
    {i18n.t(hasAvatar ? 'prof.avatar.change' : 'prof.avatar.add')}
  </Button>
</div>

<Dialog
  {open}
  title={i18n.t('prof.avatar.title')}
  onclose={close}
  oncancel={(event) => {
    // Cancel is disabled while saving; Escape follows it.
    if (step === 'saving') event.preventDefault();
  }}
>
  <div class="editor">
    {#if problem}
      <Banner tone="danger">{problem}</Banner>
    {/if}

    {#if step === 'preparing' || step === 'encoding' || step === 'saving'}
      <p role="status">
        {i18n.t(step === 'saving' ? 'mem.upload.uploading' : 'prof.avatar.working')}
      </p>
    {/if}

    {#if source && crop && (step === 'crop' || step === 'encoding')}
      <p class="hint" id="avatar-crop-hint">{i18n.t('prof.avatar.cropHint')}</p>
      <button
        type="button"
        bind:this={frame}
        class="frame"
        aria-label={i18n.t('prof.avatar.frame')}
        aria-describedby="avatar-crop-hint"
        onkeydown={keydown}
        onpointerdown={pointerdown}
        onpointermove={pointermove}
        onpointerup={pointerup}
        onpointercancel={pointerup}
      >
        <img
          src={source.url}
          alt=""
          draggable="false"
          style:width="{(source.width / crop.size) * 100}%"
          style:left="{(-crop.x / crop.size) * 100}%"
          style:top="{(-crop.y / crop.size) * 100}%"
        />
      </button>
      <div class="zoom">
        <label for="avatar-zoom">{i18n.t('prof.avatar.zoom')}</label>
        <input
          id="avatar-zoom"
          type="range"
          min="1"
          max={MAX_ZOOM}
          step="0.05"
          value={zoom}
          oninput={(event) => place(centerX, centerY, Number(event.currentTarget.value))}
        />
      </div>
    {/if}

    {#if result && (step === 'confirm' || step === 'saving')}
      <p class="hint">{i18n.t('prof.avatar.confirmHint')}</p>
      <img
        class="result"
        src={result.url}
        alt={i18n.t('prof.avatar.preview')}
        width={result.encoded.width}
        height={result.encoded.height}
      />
    {/if}

    <div class="actions">
      {#if step === 'crop' || step === 'encoding'}
        <Button
          type="button"
          variant="primary"
          disabled={!source || step === 'encoding'}
          onclick={preview}
        >
          {i18n.t('prof.avatar.next')}
        </Button>
      {:else if step === 'confirm' || step === 'saving'}
        <Button type="button" variant="primary" disabled={step === 'saving'} onclick={save}>
          {i18n.t('prof.avatar.save')}
        </Button>
        <Button type="button" disabled={step === 'saving'} onclick={back}>
          {i18n.t('prof.avatar.back')}
        </Button>
      {/if}
      <Button type="button" variant="ghost" disabled={step === 'saving'} onclick={close}>
        {i18n.t('prof.avatar.cancel')}
      </Button>
    </div>
  </div>
</Dialog>

<style>
  .editor {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    width: min(20rem, calc(100vw - 6rem));
  }

  .hint {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .frame {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    aspect-ratio: 1;
    overflow: hidden;
    border: 1px solid var(--color-divider);
    border-radius: var(--radius-control);
    background: var(--color-surface-2);
    cursor: grab;
    touch-action: none;
  }

  .frame:focus-visible {
    outline: 3px solid var(--color-focus);
    outline-offset: 2px;
  }

  .frame img {
    position: absolute;
    max-width: none;
    height: auto;
    user-select: none;
    pointer-events: none;
  }

  /* The round mask shows how the square is drawn as an avatar. */
  .frame::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--color-bg) 55%, transparent);
    pointer-events: none;
  }

  .zoom {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
  }

  .zoom label {
    font-weight: 600;
    font-size: 0.875rem;
  }

  .zoom input {
    accent-color: var(--color-accent);
  }

  .result {
    width: 100%;
    height: auto;
    border-radius: 50%;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2);
  }
</style>
