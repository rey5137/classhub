import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { muteChoiceSchema, type NotificationKinds } from '$lib/contracts/notifications';
import { t } from '$lib/i18n';
import { requireFeature } from '$lib/server/features';
import { formFailure, formText, guarded } from '$lib/server/http';
import {
  getNotifications,
  patchNotifications,
  unsubscribeDevice,
} from '$lib/server/services/notifications';

// §16.3 / R-NTF-10, 11: per-device push consent, member kind toggles, mute and device list.

export const load: PageServerLoad = async ({ locals }) => {
  requireFeature(locals, 'notifications');
  const { member, context } = guarded(locals);
  const result = await getNotifications(context, member, {
    featureEnabled: locals.settings.features.notifications,
    timeZone: locals.timeZone,
    defaultLocale: locals.locale,
  });
  if (!result.ok) error(404, t(locals.locale, 'error.not_found'));
  return {
    notifications: result.body,
    isAdmin: member.role === 'admin',
  };
};

export const actions: Actions = {
  kinds: async ({ request, locals }) => {
    requireFeature(locals, 'notifications');
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const kinds: Partial<NotificationKinds> = {
      chat: form.get('chat') === 'on',
      thread: form.get('thread') === 'on',
      reply: form.get('reply') === 'on',
      ...(member.role === 'admin' ? { join: form.get('join') === 'on' } : {}),
    };
    const result = await patchNotifications(
      context,
      member,
      { kinds },
      {
        featureEnabled: locals.settings.features.notifications,
        timeZone: locals.timeZone,
        defaultLocale: locals.locale,
      },
    );
    if (!result.ok) return formFailure('kinds', locals, result);
    return { action: 'kinds', ok: true, notifications: result.body };
  },

  mute: async ({ request, locals }) => {
    requireFeature(locals, 'notifications');
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const rawChoice = formText(form, 'choice');
    const mute =
      rawChoice === 'unmute' || !rawChoice
        ? null
        : (muteChoiceSchema.safeParse(rawChoice).data ?? null);
    const result = await patchNotifications(
      context,
      member,
      { mute },
      {
        featureEnabled: locals.settings.features.notifications,
        timeZone: locals.timeZone,
        defaultLocale: locals.locale,
      },
    );
    if (!result.ok) return formFailure('mute', locals, result);
    return { action: 'mute', ok: true, notifications: result.body };
  },

  removeDevice: async ({ request, locals }) => {
    requireFeature(locals, 'notifications');
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const id = formText(form, 'id') ?? '';
    const result = await unsubscribeDevice(context, member, id, {
      featureEnabled: locals.settings.features.notifications,
    });
    if (!result.ok) return formFailure('removeDevice', locals, result);
    return { action: 'removeDevice', ok: true, removedId: id };
  },
};
