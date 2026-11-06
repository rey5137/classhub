import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { can } from '$lib/server/auth/permissions';
import { guarded } from '$lib/server/http';
import { countActiveAdmins } from '$lib/server/services/members';

// R-AUTH-12: the bootstrap admin's checklist while the site is locked. It carries the
// lock state and nothing about any member (AC-AUTH-06).
export const load: PageServerLoad = async ({ locals }) => {
  const { member, context } = guarded(locals);
  if (!can(member, 'settings.edit')) error(403, t(locals.locale, 'error.forbidden'));
  // The pipeline's settings read already holds the lock state.
  return {
    unlocked: locals.setupUnlocked,
    // A yes/no about the admin count, never who they are.
    secondAdmin: (await countActiveAdmins(context.database.db)) >= 2,
  };
};
