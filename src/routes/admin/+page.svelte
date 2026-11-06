<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import Banner from '$lib/components/Banner.svelte';
  import Button from '$lib/components/Button.svelte';
  import Card from '$lib/components/Card.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import InfoPagesCard from './InfoPagesCard.svelte';
  import SiteSettingsCard from './SiteSettingsCard.svelte';
  import { useI18n } from '$lib/i18n/context';
  import type { MessageKey } from '$lib/i18n';
  import { mediumDate } from '$lib/shared/time';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const i18n = useI18n();

  // R-AUTH-19: warn from 45 seats, refuse at 50.
  const seatsFull = $derived(data.seats.used >= data.seats.limit);
  const seatsWarn = $derived(!seatsFull && data.seats.used >= data.seats.warnAt);

  // R-UI-11: in the viewer's time zone, the same as every other date on the page.
  const formatDate = (at: number | Date) => mediumDate(at, i18n.locale, data.timeZone);

  function statusKey(invite: (typeof data.invites)[number]): MessageKey {
    if (invite.userStatus === 'suspended') return 'admin.status.suspended';
    return `admin.status.${invite.status}`;
  }

  // Each row's buttons name the person they act on, so a screen reader's button list
  // reads "Suspend: Mai Nguyen", not "Suspend" fifty times.
  function labelFor(action: MessageKey, invite: (typeof data.invites)[number]): string {
    return i18n.t('admin.actionFor', {
      action: i18n.t(action),
      name: invite.displayName ?? invite.email,
    });
  }

  const notice = $derived(
    form && 'done' in form && form.done
      ? i18n.t(`admin.done.${form.done}` as MessageKey, {
          email: 'email' in form && typeof form.email === 'string' ? form.email : '',
        })
      : null,
  );
  const failure = $derived(form && 'message' in form ? form.message : null);
  // R-MEM-18: decimal units, the ones the 8 and 9 GB thresholds are written in; below
  // a gigabyte in megabytes, so a young class doesn't read "0 GB".
  const numberLocale = $derived(i18n.locale === 'vi' ? 'vi-VN' : 'en-GB');
  const count = $derived(new Intl.NumberFormat(numberLocale));
  const gb = (bytes: number) =>
    new Intl.NumberFormat(numberLocale, {
      style: 'unit',
      unit: bytes < 1e9 ? 'megabyte' : 'gigabyte',
      maximumFractionDigits: bytes < 1e9 ? 1 : 2,
    }).format(bytes < 1e9 ? bytes / 1e6 : bytes / 1e9);
  const fieldError = (name: string) =>
    form && 'fields' in form && form.fields && name in form.fields
      ? i18n.t('error.validation')
      : undefined;
</script>

<PageHeader title={i18n.t('admin.title')} lede={i18n.t('admin.lede')}>
  {#snippet actions()}
    <a href={resolve('/admin/setup')}>{i18n.t('admin.setupLink')}</a>
  {/snippet}
</PageHeader>

<div class="stack">
  {#if data.soleAdmin}
    <Banner tone="warning">{i18n.t('admin.secondAdmin')}</Banner>
  {/if}
  {#if notice}
    <Banner>{notice}</Banner>
  {/if}
  {#if failure}
    <Banner tone="danger">{failure}</Banner>
  {/if}

  <Card class="sheet" aria-labelledby="invite-head">
    <div class="head">
      <h2 id="invite-head">{i18n.t('admin.inviteForm')}</h2>
      <p class="seats tnum" class:warn={seatsWarn} class:full={seatsFull}>
        {i18n.t('admin.seats', { used: data.seats.used, limit: data.seats.limit })}
      </p>
    </div>
    {#if seatsFull}
      <Banner tone="danger">{i18n.t('admin.seatsFull', { limit: data.seats.limit })}</Banner>
    {:else if seatsWarn}
      <Banner tone="warning">{i18n.t('admin.seatsWarning', { limit: data.seats.limit })}</Banner>
    {/if}
    <form method="POST" action="?/invite" class="invite" use:enhance>
      <FormField
        id="invite-email"
        name="email"
        type="email"
        label={i18n.t('admin.email')}
        autocomplete="off"
        maxlength={254}
        required
        error={form?.action === 'invite' ? fieldError('email') : undefined}
      />
      <FormField
        id="invite-name"
        name="displayName"
        label={i18n.t('admin.displayName')}
        autocomplete="off"
        maxlength={80}
        required
        error={form?.action === 'invite' ? fieldError('displayName') : undefined}
      />
      <div class="field">
        <label for="invite-role">{i18n.t('admin.role')}</label>
        <select id="invite-role" name="role">
          <option value="member">{i18n.t('admin.role.member')}</option>
          <option value="admin">{i18n.t('admin.role.admin')}</option>
        </select>
      </div>
      <Button type="submit" variant="primary" disabled={seatsFull}>
        {i18n.t('admin.inviteSubmit')}
      </Button>
    </form>
    <p class="hint">{i18n.t('admin.inviteHint')}</p>
  </Card>

  <Card class="sheet" aria-labelledby="list-head">
    <div class="head">
      <h2 id="list-head">{i18n.t('admin.list')}</h2>
    </div>
    {#if data.invites.length === 0}
      <p class="muted">{i18n.t('admin.empty')}</p>
    {:else}
      <ul class="people">
        {#each data.invites as invite (invite.id)}
          <li class="person">
            <div class="who">
              <p class="name">
                {invite.displayName ?? invite.email}
                {#if invite.userId === data.selfId}<span class="muted">({i18n.t('admin.you')})</span
                  >{/if}
              </p>
              <p class="email">{invite.email}</p>
              <p class="meta">
                <span class="status {invite.userStatus ?? invite.status}"
                  >{i18n.t(statusKey(invite))}</span
                >
                <span>{i18n.t(`admin.role.${invite.role}`)}</span>
                {#if invite.status === 'pending' && invite.expiresAt}
                  <span class="tnum"
                    >{i18n.t('admin.expires', { date: formatDate(invite.expiresAt) })}</span
                  >
                {/if}
                {#if invite.deletionRequestedAt !== null && invite.status === 'accepted'}
                  <span class="status suspended">{i18n.t('admin.deletionRequested')}</span>
                {/if}
                <span class="access" class:synced={invite.accessSyncedAt !== null}>
                  {invite.accessSyncedAt !== null
                    ? i18n.t('admin.access.synced')
                    : i18n.t('admin.access.manual')}
                </span>
              </p>
            </div>
            <div class="actions">
              {#if invite.status === 'pending' || invite.status === 'expired'}
                <form method="POST" action="?/revoke" use:enhance>
                  <input type="hidden" name="id" value={invite.id} />
                  <Button
                    type="submit"
                    variant="ghost"
                    aria-label={labelFor('admin.revoke', invite)}>{i18n.t('admin.revoke')}</Button
                  >
                </form>
              {/if}
              {#if invite.userId && invite.userId !== data.selfId && invite.status === 'accepted'}
                <form method="POST" action="?/member" use:enhance>
                  <input type="hidden" name="userId" value={invite.userId} />
                  {#if invite.userStatus === 'active'}
                    <input type="hidden" name="status" value="suspended" />
                    <Button
                      type="submit"
                      variant="ghost"
                      aria-label={labelFor('admin.suspend', invite)}
                      >{i18n.t('admin.suspend')}</Button
                    >
                  {:else if invite.userStatus === 'suspended'}
                    <input type="hidden" name="status" value="active" />
                    <Button
                      type="submit"
                      variant="ghost"
                      aria-label={labelFor('admin.reactivate', invite)}
                      >{i18n.t('admin.reactivate')}</Button
                    >
                  {/if}
                </form>
                {#if invite.deletionRequestedAt !== null && invite.status === 'accepted'}
                  <form method="POST" action="?/member" use:enhance>
                    <input type="hidden" name="userId" value={invite.userId} />
                    <input type="hidden" name="deletion" value="complete" />
                    <Button
                      type="submit"
                      variant="ghost"
                      aria-label={labelFor('admin.completeDeletion', invite)}
                      >{i18n.t('admin.completeDeletion')}</Button
                    >
                  </form>
                {/if}
                {#if invite.userStatus === 'active'}
                  <form method="POST" action="?/member" use:enhance>
                    <input type="hidden" name="userId" value={invite.userId} />
                    <input
                      type="hidden"
                      name="role"
                      value={invite.role === 'admin' ? 'member' : 'admin'}
                    />
                    <Button
                      type="submit"
                      variant="ghost"
                      aria-label={labelFor(
                        invite.role === 'admin' ? 'admin.makeMember' : 'admin.makeAdmin',
                        invite,
                      )}
                    >
                      {invite.role === 'admin'
                        ? i18n.t('admin.makeMember')
                        : i18n.t('admin.makeAdmin')}
                    </Button>
                  </form>
                {/if}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <!-- R-AUTH-18: the Worker holds no Cloudflare token; the policy changes from the CLI. -->
    <div class="step">
      <p>{i18n.t('admin.access.step')}</p>
      <code>npm run invite -- add|remove &lt;email&gt;</code>
    </div>
  </Card>

  {#if data.usage}
    {@const usage = data.usage}
    <Card class="sheet" aria-labelledby="usage-head">
      <div class="head">
        <h2 id="usage-head">{i18n.t('admin.usage')}</h2>
        <p class="seats tnum" class:warn={usage.warning}>
          {i18n.t('admin.usage.used', { used: gb(usage.usedBytes), stop: gb(usage.stopBytes) })}
        </p>
      </div>
      {#if usage.warning}
        <Banner tone="warning"
          >{i18n.t('admin.usage.warning', { warn: gb(usage.warnBytes) })}</Banner
        >
      {/if}
      <dl class="usage">
        <div>
          <dt>{i18n.t('admin.usage.committed')}</dt>
          <dd class="tnum">{gb(usage.committedBytes)}</dd>
        </div>
        <div>
          <dt>{i18n.t('admin.usage.reserved')}</dt>
          <dd class="tnum">{gb(usage.reservedBytes)}</dd>
        </div>
        <div>
          <dt>{i18n.t('admin.usage.photos')}</dt>
          <dd class="tnum">{count.format(usage.photos)}</dd>
        </div>
        <div>
          <dt>{i18n.t('admin.usage.reconciled')}</dt>
          <dd class="tnum">
            {usage.lastReconciledAt === null
              ? i18n.t('admin.usage.never')
              : formatDate(usage.lastReconciledAt)}
          </dd>
        </div>
        <div>
          <dt>{i18n.t('admin.usage.classA', { month: usage.operations.month })}</dt>
          <dd class="tnum">{count.format(usage.operations.classA)}</dd>
        </div>
        <div>
          <dt>{i18n.t('admin.usage.classB', { month: usage.operations.month })}</dt>
          <dd class="tnum">{count.format(usage.operations.classB)}</dd>
        </div>
      </dl>
      <p class="hint">{i18n.t('admin.usage.estimate')}</p>
      <p class="hint">{i18n.t('admin.usage.notBilling')}</p>
      <!-- R-MEM-18: Cloudflare picks the account; no account id lives in the code. -->
      <p>
        <a href="https://dash.cloudflare.com/?to=/:account/r2" rel="external noopener noreferrer"
          >{i18n.t('admin.usage.dashboard')}</a
        >
      </p>
    </Card>
  {/if}

  <SiteSettingsCard settings={data.settings} themes={data.themes} form={form ?? null} />

  <InfoPagesCard pages={data.infoPages} form={form ?? null} />
</div>

<style>
  .stack {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    min-width: 0;
  }

  .stack :global(.sheet) {
    display: grid;
    gap: calc(var(--space-unit) * 4);
    padding: calc(var(--space-unit) * 5);
  }

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

  .seats {
    color: var(--color-muted);
    font: var(--text-small);
  }

  .seats.warn {
    color: var(--color-warning);
  }

  .seats.full {
    color: var(--color-danger);
  }

  .invite {
    display: grid;
    gap: calc(var(--space-unit) * 3);
    align-items: end;
  }

  @media (min-width: 768px) {
    .invite {
      grid-template-columns: minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1fr) auto;
    }
  }

  .field {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
    min-width: 0;
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
    margin-top: calc(var(--space-unit) * -2);
    color: var(--color-muted);
    font: var(--text-small);
  }

  .people {
    display: grid;
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .person {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
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
  }

  .email {
    color: var(--color-muted);
    font: var(--text-small);
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 1) calc(var(--space-unit) * 3);
    color: var(--color-muted);
    font: var(--text-small);
  }

  .status {
    font-weight: 600;
    color: var(--color-text);
  }

  .status.suspended,
  .status.revoked,
  .status.expired {
    color: var(--color-danger);
  }

  .access.synced {
    color: var(--color-success);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: calc(var(--space-unit) * 1);
  }

  .usage {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: calc(var(--space-unit) * 4);
    margin: 0;
  }

  @media (min-width: 768px) {
    .usage {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .usage dt {
    color: var(--color-muted);
    font: var(--text-small);
  }

  .usage dd {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
  }

  .muted {
    color: var(--color-muted);
  }

  .step {
    display: grid;
    gap: calc(var(--space-unit) * 1.5);
    padding-top: calc(var(--space-unit) * 3);
    border-top: 1px solid var(--color-divider);
    color: var(--color-muted);
    font: var(--text-small);
  }

  code {
    overflow-wrap: anywhere;
    color: var(--color-text);
  }

  a {
    color: var(--color-accent);
    font-weight: 600;
  }
</style>
