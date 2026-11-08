<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { Encoded } from '$lib/client/image/encode';
  import { IMAGE_ACCEPT } from '$lib/client/image/policy';
  import { UploadError, uploadEncoded, type CompleteFields } from '$lib/client/upload';
  import type { MessageKey } from '$lib/i18n';
  import { useI18n } from '$lib/i18n/context';
  import Banner from './Banner.svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import FormField from './FormField.svelte';
  import type { PagedList } from '$lib/client/paged-list.svelte';
  import LoadMore from './LoadMore.svelte';

  // §7.1–7.2: pick, encode in the browser, preview the stored copy, then upload one
  // photo at a time. Each photo gets its own caption; album and year carry over.
  // R-UI-01: `purpose: 'site'` uploads one banner, logo or favicon picture (no caption,
  // album or year, kept out of the gallery) and hands its id to `onuploaded`.

  interface Props {
    open: boolean;
    albums?: { id: string; name: string }[];
    albumsPager?: PagedList<{ id: string; name: string }>;
    purpose?: 'photo' | 'site';
    title?: string;
    onuploaded?: (mediaId: string) => void;
    onclose: () => void;
  }

  let {
    open,
    albums = [],
    albumsPager,
    purpose = 'photo',
    title,
    onuploaded,
    onclose,
  }: Props = $props();
  const i18n = useI18n();

  type Phase = 'pick' | 'preparing' | 'ready' | 'uploading' | 'stopped' | 'done';
  let phase = $state<Phase>('pick');
  let queue = $state<File[]>([]);
  let index = $state(0);
  let progress = $state(0);
  let encoded = $state<Encoded | null>(null);
  let previewUrl = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let uploaded = $state(0);
  let caption = $state('');
  let albumId = $state('');
  let year = $state('');
  let fileInput = $state<HTMLInputElement>();
  // Bumped by close(): an encode or upload still running from before is dropped when it ends.
  let run = 0;
  // Uploads the page data doesn't show yet.
  let unseen = 0;

  const current = $derived(queue[index]);
  const yearInvalid = $derived(year.trim() !== '' && !/^[1-9]\d{3}$/.test(year.trim()));
  const kilobytes = $derived(
    new Intl.NumberFormat(i18n.locale === 'vi' ? 'vi-VN' : 'en-GB', {
      style: 'unit',
      unit: 'kilobyte',
      maximumFractionDigits: 0,
    }),
  );

  function setPreview(next: Encoded | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    encoded = next;
    previewUrl = next ? URL.createObjectURL(next.image) : null;
  }

  onDestroy(() => setPreview(null));

  function refresh() {
    if (unseen === 0) return;
    unseen = 0;
    void invalidateAll();
  }

  async function focusOn(id: string) {
    await tick();
    document.getElementById(id)?.focus();
  }

  async function prepare() {
    setPreview(null);
    problem = null;
    const file = queue[index];
    if (!file) {
      phase = 'done';
      refresh();
      return;
    }
    const mine = run;
    phase = 'preparing';
    progress = 0;
    // Loaded on demand: the encoder and its worker never run during SSR.
    const { prepareImage, EncodeRefusal } = await import('$lib/client/image/client');
    if (mine !== run) return;
    try {
      const result = await prepareImage(file, { kind: 'photo' }, (fraction) => {
        if (mine === run) progress = fraction;
      });
      if (mine !== run) return;
      setPreview(result);
      phase = 'ready';
      void focusOn(purpose === 'site' ? 'upload-submit' : 'upload-caption');
    } catch (error) {
      if (mine !== run) return;
      // R-MEM-01: refused here, before any request leaves the browser.
      const reason = error instanceof EncodeRefusal ? error.reason : 'undecodable';
      problem = i18n.t(`image.refused.${reason}` as MessageKey, { name: file.name });
      phase = 'stopped';
      void focusOn('upload-skip');
    }
  }

  function picked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    queue = Array.from(input.files ?? []);
    input.value = '';
    index = 0;
    uploaded = 0;
    if (queue.length > 0) void prepare();
  }

  function next() {
    caption = '';
    index += 1;
    void prepare();
  }

  async function upload() {
    if (!encoded || yearInvalid) return;
    const fields: CompleteFields = {};
    if (caption.trim()) fields.caption = caption.trim();
    if (albumId) fields.albumId = albumId;
    if (year.trim()) fields.takenYear = Number(year.trim());
    const mine = run;
    phase = 'uploading';
    progress = 0;
    problem = null;
    try {
      const id = await uploadEncoded(
        encoded,
        purpose,
        purpose === 'site' ? {} : fields,
        (fraction) => {
          if (mine === run) progress = fraction;
        },
      );
      if (purpose === 'site') {
        onuploaded?.(id);
        if (mine === run) close();
        return;
      }
      if (mine !== run) {
        // Stored after the sheet closed: the page still has to show it.
        void invalidateAll();
        return;
      }
      uploaded += 1;
      unseen += 1;
      next();
    } catch (error) {
      if (mine !== run) return;
      const code = error instanceof UploadError ? error.code : 'internal';
      problem = i18n.t(`upload.error.${code}`);
      // Paused storage or a spent limit won't clear for the rest of the queue.
      if (code === 'storage_full' || code.startsWith('rate_limited')) {
        phase = 'done';
        refresh();
      } else {
        phase = 'ready';
      }
    }
  }

  function close() {
    run += 1;
    refresh();
    setPreview(null);
    queue = [];
    phase = 'pick';
    problem = null;
    onclose();
  }
</script>

<Dialog
  {open}
  title={title ?? i18n.t('mem.upload.title')}
  onclose={close}
  oncancel={(event) => {
    // Close is disabled while a photo uploads; Escape follows it.
    if (phase === 'uploading') event.preventDefault();
  }}
>
  <div class="sheet">
    <p class="notice">{i18n.t('mem.upload.originals')}</p>

    {#if phase === 'pick' || phase === 'done' || phase === 'stopped'}
      <div class="pick">
        <!-- The native control's own text follows the browser's language, not R-UI-10's. -->
        <input
          bind:this={fileInput}
          id="upload-files"
          class="visually-hidden"
          type="file"
          multiple={purpose === 'photo'}
          accept={IMAGE_ACCEPT}
          tabindex="-1"
          aria-hidden="true"
          onchange={picked}
        />
        <div>
          <Button
            type="button"
            aria-describedby="upload-files-hint"
            onclick={() => fileInput?.click()}
          >
            {i18n.t('mem.upload.pick')}
          </Button>
        </div>
        <p id="upload-files-hint" class="hint">{i18n.t('mem.upload.pickHint')}</p>
      </div>
    {/if}

    {#if queue.length > 1 && current}
      <p class="hint">{i18n.t('mem.upload.queue', { index: index + 1, total: queue.length })}</p>
    {/if}

    {#if phase === 'preparing' || phase === 'uploading'}
      <div class="progress" role="status">
        <label for="upload-progress">
          {i18n.t(phase === 'preparing' ? 'mem.upload.preparing' : 'mem.upload.uploading')}
        </label>
        <progress id="upload-progress" max="1" value={progress}></progress>
      </div>
    {/if}

    {#if problem}
      <Banner tone="danger">{problem}</Banner>
    {/if}

    {#if encoded && previewUrl && current && (phase === 'ready' || phase === 'uploading')}
      <figure class="preview">
        <img
          src={previewUrl}
          alt={i18n.t('mem.upload.preview', { name: current.name })}
          width={encoded.width}
          height={encoded.height}
        />
        <figcaption class="hint">
          {i18n.t('mem.upload.size', {
            width: encoded.width,
            height: encoded.height,
            size: kilobytes.format((encoded.image.size + (encoded.thumb?.size ?? 0)) / 1000),
          })}
        </figcaption>
      </figure>
      <form
        class="fields"
        onsubmit={(event) => {
          event.preventDefault();
          void upload();
        }}
      >
        {#if purpose === 'photo'}
          <FormField
            id="upload-caption"
            label={i18n.t('mem.upload.caption')}
            multiline
            maxlength={500}
            bind:value={caption}
          />
          {#if albums.length > 0}
            <div class="field">
              <label for="upload-album">{i18n.t('mem.upload.album')}</label>
              <select id="upload-album" bind:value={albumId}>
                <option value="">{i18n.t('mem.upload.noAlbum')}</option>
                {#each albums as album (album.id)}
                  <option value={album.id}>{album.name}</option>
                {/each}
              </select>
              {#if albumsPager}
                <LoadMore pager={albumsPager} variant="button" />
              {/if}
            </div>
          {/if}
          <FormField
            id="upload-year"
            label={i18n.t('mem.upload.year')}
            hint={i18n.t('mem.upload.yearHint')}
            error={yearInvalid ? i18n.t('mem.upload.yearInvalid') : undefined}
            inputmode="numeric"
            maxlength={4}
            bind:value={year}
          />
        {/if}
        <div class="actions">
          <Button
            type="submit"
            id="upload-submit"
            variant="primary"
            disabled={phase === 'uploading' || yearInvalid}
          >
            {i18n.t('mem.upload.submit')}
          </Button>
          <Button type="button" variant="ghost" disabled={phase === 'uploading'} onclick={next}>
            {i18n.t('mem.upload.skip')}
          </Button>
        </div>
      </form>
    {:else if phase === 'stopped'}
      <div class="actions">
        <Button type="button" id="upload-skip" onclick={next}>{i18n.t('mem.upload.skip')}</Button>
      </div>
    {/if}

    {#if phase === 'done' && uploaded > 0}
      <p class="done" role="status">
        {uploaded === 1
          ? i18n.t('mem.upload.doneOne')
          : i18n.t('mem.upload.done', { count: uploaded })}
      </p>
    {/if}

    <div class="actions end">
      <Button type="button" variant="ghost" disabled={phase === 'uploading'} onclick={close}>
        {i18n.t('mem.upload.close')}
      </Button>
    </div>
  </div>
</Dialog>

<style>
  .sheet {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    width: min(28rem, calc(100vw - 6rem));
  }

  .notice,
  .hint {
    color: var(--color-muted);
    font-size: 0.875rem;
  }

  .pick,
  .progress,
  .field,
  .fields {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
  }

  .fields {
    gap: calc(var(--space-unit) * 4);
  }

  .progress label,
  .field label {
    font-weight: 600;
    font-size: 0.875rem;
  }

  progress {
    width: 100%;
    accent-color: var(--color-accent);
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

  .preview {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
    margin: 0;
  }

  .preview img {
    width: 100%;
    height: auto;
    max-height: 40vh;
    object-fit: contain;
    border-radius: var(--radius-control);
    background: var(--color-surface-2);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 2);
  }

  .end {
    justify-content: flex-end;
  }

  .done {
    font-weight: 600;
  }
</style>
