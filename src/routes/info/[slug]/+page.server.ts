import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { guarded } from '$lib/server/http';
import { getInfo } from '$lib/server/services/info';

// R-BRD-02: an info page for members; an unknown slug is a 404.
export const load: PageServerLoad = async ({ locals, params }) => {
  const { member, context } = guarded(locals);
  const result = await getInfo(context, member, params, locals.settings.features, locals.locale);
  if (!result.ok) {
    error(result.code === 'not_found' ? 404 : 403, t(locals.locale, `error.${result.code}`));
  }
  return { page: result.body };
};
