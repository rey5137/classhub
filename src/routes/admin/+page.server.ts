import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { can } from '$lib/server/auth/permissions';
import { formFailure, formText, guarded } from '$lib/server/http';
import {
  adminCreateInvite,
  adminListInvites,
  adminPatchMember,
  adminRevokeInvite,
} from '$lib/server/services/admin';
import {
  adminApproveJoinRequest,
  adminListJoinRequests,
  adminRejectJoinRequest,
} from '$lib/server/services/join';
import { chatOverRetention } from '$lib/server/repositories/chat-archive';
import { findAuthEmail } from '$lib/server/repositories/users';
import { siteConfig } from '$lib/config';
import { countActiveAdmins } from '$lib/server/services/members';
import { usageSummary } from '$lib/server/services/gallery';
import { adminInfoPages, createInfo, editInfo, removeInfo } from '$lib/server/services/info';
import { applyAppearance } from '$lib/server/appearance';
import { updateSettings } from '$lib/server/services/settings';
import { siteMediaKeys, type Feature, type Features } from '$lib/contracts/settings';
import { themes } from '$lib/themes/registry';

const featureKeys: Feature[] = ['memories', 'discussions', 'chat', 'join'];

// R-NAV-03: the invite screen loads here, after the membership check; R-NAV-05 refuses
// everyone but admins before any row is read.

export const load: PageServerLoad = async ({ locals }) => {
  const { member, context } = guarded(locals);
  if (!can(member, 'members.manage')) error(403, t(locals.locale, 'error.forbidden'));
  const list = await adminListInvites(context, member);
  if (!list.ok) error(403, t(locals.locale, 'error.forbidden'));
  const joinQueue = await adminListJoinRequests(context, member);
  return {
    invites: list.body.items,
    seats: list.body.seats,
    // R-AUTH-30: the queue card; shown while join is on or requests still wait.
    join: {
      enabled: locals.settings.features.join,
      ...(joinQueue.ok ? joinQueue.body : { items: [], full: false }),
    },
    soleAdmin: (await countActiveAdmins(context.database.db)) < 2,
    selfId: member.id,
    usage: await usageSummary(context, member),
    infoPages: (await adminInfoPages(context, member)) ?? [],
    // R-CHAT-14: messages over R-CHAT-13's limits with no verified archive yet.
    chatOverRetention: await chatOverRetention(context.database, siteConfig.chat, Date.now()),
    // R-UI-01: the effective settings this request already read; `settings.edit` is admin-only too.
    settings: locals.settings,
    themes: Object.values(themes).map(({ id, modes }) => ({ id, modes })),
  };
};

/**
 * R-UI-01: the settings form as a PATCH body. Every scalar field is sent, so an empty
 * accent box clears that mode's accent. A feature is sent only when its box differs from
 * the hidden `was-<feature>` value the page was loaded with, so a save from a stale page
 * never reverts another admin's toggle. A form without the hidden value is compared with
 * the stored flag.
 */
function settingsInput(form: FormData, current: Features) {
  const theme = formText(form, 'theme');
  const modes = theme && theme in themes ? themes[theme as keyof typeof themes].modes : [];
  const accent: Record<string, string> = {};
  for (const mode of modes) {
    const colour = formText(form, `accent-${mode}`)?.trim().toLowerCase();
    if (colour) accent[mode] = colour;
  }
  const features: Partial<Features> = {};
  for (const feature of featureKeys) {
    const submitted = form.get(feature) === 'on';
    const was = form.has(`was-${feature}`) ? form.get(`was-${feature}`) === 'on' : current[feature];
    if (submitted !== was) features[feature] = submitted;
  }
  return {
    name: formText(form, 'name')?.trim(),
    years: formText(form, 'years')?.trim(),
    description: formText(form, 'description')?.trim() ?? '',
    welcome: formText(form, 'welcome') ?? '',
    theme,
    mode: formText(form, 'mode'),
    accent: Object.keys(accent).length > 0 ? accent : null,
    density: formText(form, 'density'),
    locale: formText(form, 'locale'),
    ...(Object.keys(features).length > 0 ? { features } : {}),
  };
}

/** R-BRD-02: an info page form; a missing number reads as `NaN`, which the schema refuses. */
function infoInput(form: FormData) {
  const sortOrder = formText(form, 'sortOrder')?.trim();
  return {
    slug: formText(form, 'slug')?.trim(),
    title: formText(form, 'title'),
    body: formText(form, 'body'),
    isPinned: form.get('isPinned') === 'on',
    sortOrder: sortOrder ? Number(sortOrder) : 0,
  };
}

export const actions: Actions = {
  invite: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const result = await adminCreateInvite(context, member, {
      email: formText(form, 'email'),
      displayName: formText(form, 'displayName'),
      role: formText(form, 'role') ?? 'member',
    });
    if (!result.ok) return formFailure('invite', locals, result);
    return { action: 'invite', done: result.body.created ? 'created' : 'unchanged' };
  },
  revoke: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const result = await adminRevokeInvite(context, member, { id: formText(form, 'id') });
    if (!result.ok) return formFailure('revoke', locals, result);
    return { action: 'revoke', done: 'revoked' };
  },
  joinApprove: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const id = formText(await request.formData(), 'id') ?? '';
    const result = await adminApproveJoinRequest(context, member, id);
    if (!result.ok) return formFailure('joinApprove', locals, result, id);
    return { action: 'joinApprove', done: 'joinApproved' };
  },
  joinReject: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const id = formText(await request.formData(), 'id') ?? '';
    const result = await adminRejectJoinRequest(context, member, id);
    if (!result.ok) return formFailure('joinReject', locals, result, id);
    return { action: 'joinReject', done: 'joinRejected' };
  },
  member: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const role = formText(form, 'role');
    const status = formText(form, 'status');
    const deletion = formText(form, 'deletion');
    const userId = formText(form, 'userId') ?? '';
    // R-PROF-11: the tombstone replaces the login email, so read it first; the admin
    // still has to drop it from the Access policy, and sees it only on success.
    const email = deletion ? await findAuthEmail(context.database.db, userId) : null;
    const result = await adminPatchMember(
      context,
      member,
      userId,
      role ? { role } : deletion ? { deletion } : { status },
    );
    if (!result.ok) return formFailure('member', locals, result);
    if (deletion && result.body.changed && email) {
      return { action: 'member', done: 'deleted', email };
    }
    return { action: 'member', done: 'updated' };
  },
  // Not enhanced: a plain POST re-renders /admin with the new theme already applied.
  settings: async (event) => {
    const { locals, request } = event;
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const result = await updateSettings(
      context,
      member,
      locals.settings,
      settingsInput(form, locals.settings.features),
    );
    if (!result.ok) return formFailure('settings', locals, result);
    // The pipeline read the settings before this write; this response shows the new ones.
    locals.settings = result.body;
    applyAppearance(event);
    return { action: 'settings', done: 'settingsSaved' };
  },
  // R-UI-01: "Remove" for the banner, logo or favicon (an upload saves through the API).
  settingsMedia: async (event) => {
    const { locals, request } = event;
    const { member, context } = guarded(locals);
    const key = formText(await request.formData(), 'remove');
    if (!siteMediaKeys.some((known) => known === key)) {
      return formFailure('settings', locals, { ok: false, code: 'validation' });
    }
    const result = await updateSettings(context, member, locals.settings, { [key!]: null });
    if (!result.ok) return formFailure('settings', locals, result);
    locals.settings = result.body;
    applyAppearance(event);
    return { action: 'settings', done: 'settingsSaved' };
  },
  infoCreate: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const result = await createInfo(
      context,
      member,
      infoInput(await request.formData()),
      locals.settings.features,
    );
    if (!result.ok) return formFailure('infoCreate', locals, result);
    return { action: 'infoCreate', done: 'infoCreated' };
  },
  infoEdit: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const id = formText(form, 'id');
    const result = await editInfo(
      context,
      member,
      { id },
      infoInput(form),
      locals.settings.features,
    );
    if (!result.ok) return formFailure('infoEdit', locals, result, id);
    return { action: 'infoEdit', done: 'infoSaved' };
  },
  infoDelete: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const result = await removeInfo(context, member, {
      id: formText(await request.formData(), 'id'),
    });
    if (!result.ok) return formFailure('infoDelete', locals, result);
    return { action: 'infoDelete', done: 'infoDeleted' };
  },
};
