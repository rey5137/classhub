import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { siteConfig } from '$lib/config';
import { PROFILE_FIELDS } from '$lib/contracts/profile';
import { t } from '$lib/i18n';
import { formFailure, formText, guarded } from '$lib/server/http';
import {
  clearOwnProfile,
  getOwnProfile,
  requestDeletion,
  updateOwnProfile,
} from '$lib/server/services/profiles';

// R-NAV-03: the member's own profile; every action takes the same service path as
// `/api/v1/me`, so validation and the profile rate limit apply alike (R-AUTH-21).

/** The optional fields this class shows (`site.config.ts`), plus the preferred name. */
const editable = PROFILE_FIELDS.filter(
  (field) =>
    field === 'preferred_name' || (siteConfig.profileFields as readonly string[]).includes(field),
);

export const load: PageServerLoad = async ({ locals }) => {
  const { member, context } = guarded(locals);
  const result = await getOwnProfile(context, member);
  if (!result.ok) error(404, t(locals.locale, 'error.not_found'));
  const { profile, visibility, deletionRequestedAt, deletionKeepContent } = result.body;
  // The login email is not rendered on this page: nothing here needs it (R-PROF-05).
  return { profile, visibility, deletionRequestedAt, deletionKeepContent, fields: editable };
};

const camel = {
  preferred_name: 'preferredName',
  contact_email: 'contactEmail',
  phone: 'phone',
  messaging_url: 'messagingUrl',
  city: 'city',
  bio: 'bio',
} as const;

export const actions: Actions = {
  save: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const text = (name: string) => formText(form, name);
    const input: Record<string, unknown> = { displayName: text('displayName') };
    const visibility: Record<string, unknown> = {};
    for (const field of editable) {
      if (field === 'avatar_media_id') continue;
      input[camel[field]] = text(field) ?? '';
      const chosen = text(`visibility.${field}`);
      if (chosen !== undefined) visibility[field] = chosen;
    }
    input.visibility = visibility;
    const result = await updateOwnProfile(context, member, input);
    if (!result.ok) return formFailure('save', locals, result);
    return { action: 'save', done: 'saved' };
  },
  clear: async ({ locals }) => {
    const { member, context } = guarded(locals);
    const result = await clearOwnProfile(context, member);
    if (!result.ok) return formFailure('clear', locals, result);
    return { action: 'clear', done: 'cleared' };
  },
  deletion: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const choice = form.get('keepContent');
    const result = await requestDeletion(context, member, {
      keepContent: choice === 'keep' ? true : choice === 'delete' ? false : undefined,
    });
    if (!result.ok) return formFailure('deletion', locals, result);
    return { action: 'deletion', done: 'requested' };
  },
};
