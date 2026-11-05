import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { can } from '$lib/server/auth/permissions';
import { formFailure, guarded } from '$lib/server/http';
import {
  adminCreateInvite,
  adminListInvites,
  adminPatchMember,
  adminRevokeInvite,
} from '$lib/server/services/admin';
import { findAuthEmail } from '$lib/server/repositories/users';
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
    if (!result.ok) return formFailure('invite', locals, result);
    return { action: 'invite', done: result.body.created ? 'created' : 'unchanged' };
  },
  revoke: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const result = await adminRevokeInvite(context, member, { id: text(form, 'id') });
    if (!result.ok) return formFailure('revoke', locals, result);
    return { action: 'revoke', done: 'revoked' };
  },
  member: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const role = text(form, 'role');
    const status = text(form, 'status');
    const deletion = text(form, 'deletion');
    const userId = text(form, 'userId') ?? '';
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
};
