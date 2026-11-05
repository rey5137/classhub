import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { can } from '$lib/server/auth/permissions';
import { guarded } from '$lib/server/http';
import {
  adminCreateInvite,
  adminListInvites,
  adminPatchMember,
  adminRevokeInvite,
  type AdminFailure,
} from '$lib/server/services/admin';
import { countActiveAdmins } from '$lib/server/services/members';

// R-NAV-03: the invite screen loads here, after the membership check; R-NAV-05 refuses
// everyone but admins before any row is read.

export const load: PageServerLoad = async ({ locals }) => {
  const { member, context } = guarded(locals);
  if (!can(member, 'members.manage')) error(403, t(locals.locale, 'error.forbidden'));
  const list = await adminListInvites(context, member);
  if (!list.ok) error(403, t(locals.locale, 'error.forbidden'));
  return {
    invites: list.body.items,
    seats: list.body.seats,
    soleAdmin: (await countActiveAdmins(context.database.db)) < 2,
    selfId: member.id,
  };
};

function failed(action: string, locals: App.Locals, result: AdminFailure) {
  const status = { validation: 400, forbidden: 403, not_found: 404, rate_limited: 429 }[
    result.code as 'validation'
  ];
  return fail(status ?? 409, {
    action,
    message: t(locals.locale, result.messageKey ?? `error.${result.code}`),
    fields: result.fields ?? {},
  });
}

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

export const actions: Actions = {
  invite: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const result = await adminCreateInvite(context, member, {
      email: text(form, 'email'),
      displayName: text(form, 'displayName'),
      role: text(form, 'role') ?? 'member',
    });
    if (!result.ok) return failed('invite', locals, result);
    return { action: 'invite', done: result.body.created ? 'created' : 'unchanged' };
  },
  revoke: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const result = await adminRevokeInvite(context, member, { id: text(form, 'id') });
    if (!result.ok) return failed('revoke', locals, result);
    return { action: 'revoke', done: 'revoked' };
  },
  member: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const role = text(form, 'role');
    const status = text(form, 'status');
    const result = await adminPatchMember(
      context,
      member,
      text(form, 'userId') ?? '',
      role ? { role } : { status },
    );
    if (!result.ok) return failed('member', locals, result);
    return { action: 'member', done: 'updated' };
  },
};
