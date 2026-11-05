import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { guarded } from '$lib/server/http';
import { getMemberProfile } from '$lib/server/services/profiles';

// R-NAV-03: one classmate, projected for the viewer (R-PROF-04, R-PROF-13).
export const load: PageServerLoad = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  const result = await getMemberProfile(context, member, params.id);
  if (!result.ok) {
    error(result.code === 'not_found' ? 404 : 403, t(locals.locale, `error.${result.code}`));
  }
  return { profile: result.body, self: result.body.id === member.id };
};
