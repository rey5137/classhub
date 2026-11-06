import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { formText } from '$lib/server/http';
import { joinQueueFull, submitJoinRequest } from '$lib/server/services/join';
import { TURNSTILE_SCRIPT } from '$lib/server/services/turnstile';

// R-AUTH-27: reached without Access, only while `join` is on (the pipeline's `joinGate`);
// `locals.member` is always null here, so nothing member-only can render.

function joinContext(locals: App.Locals) {
  if (!locals.context || !locals.joinOpen) error(404, t(locals.locale, 'error.not_found'));
  return locals.context;
}

export const load: PageServerLoad = async ({ locals, request }) => {
  const context = joinContext(locals);
  // R-AUTH-28: after a submission the action's result alone decides the page, so the
  // data is the same for every email, whether its row made the queue full or not.
  const closed = request.method === 'POST' ? false : await joinQueueFull(context.database.db);
  return {
    closed,
    turnstile: context.turnstile
      ? { siteKey: context.turnstile.siteKey, script: TURNSTILE_SCRIPT }
      : null,
  };
};

export const actions: Actions = {
  default: async ({ locals, request, getClientAddress }) => {
    const context = joinContext(locals);
    const form = await request.formData();
    const values = {
      name: formText(form, 'name') ?? '',
      email: formText(form, 'email') ?? '',
      note: formText(form, 'note') ?? '',
    };
    // R-AUTH-29: without a stable salt the per-IP limit can't hold across isolates, so a
    // production build missing `LOG_HASH_SALT` takes no requests at all.
    const salt = locals.joinSalt;
    if (!salt) {
      warnMissingSalt();
      return fail(503, { retry: 'later' as const, values });
    }
    const outcome = await submitJoinRequest(
      context,
      { ...values, token: formText(form, 'cf-turnstile-response') ?? '' },
      { address: clientAddress(getClientAddress), salt },
    );
    switch (outcome.kind) {
      case 'accepted':
        return { sent: true as const };
      case 'closed':
        return fail(409, { closed: true as const });
      case 'invalid': {
        // A missing token (sent before the widget issued one) reads as a failed check.
        const { token, ...fields } = outcome.fields;
        return fail(400, { fields, values, ...(token ? { retry: 'verify' as const } : {}) });
      }
      case 'unverified':
        return fail(400, { retry: 'verify' as const, values });
      case 'rate_limited':
        return fail(429, { retry: 'rate' as const, values });
    }
  },
};

let warned = false;

/** One `config` line per isolate, without any value (R-AUTH-23). */
function warnMissingSalt(): void {
  if (warned) return;
  warned = true;
  console.warn(
    JSON.stringify({ level: 'warn', config: 'LOG_HASH_SALT is not set: /join refuses requests' }),
  );
}

function clientAddress(getClientAddress: () => string): string {
  try {
    return getClientAddress();
  } catch {
    return '';
  }
}
