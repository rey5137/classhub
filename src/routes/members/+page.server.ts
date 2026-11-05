import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { guarded } from '$lib/server/http';
import { listMembers } from '$lib/server/services/profiles';

// R-NAV-03 / R-PROF-08: the directory loads here, after the membership check.
export const load: PageServerLoad = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  const q = (url.searchParams.get('q') ?? '').slice(0, 80);
  const cursor = url.searchParams.get('cursor');
  const result = await listMembers(context, member, {
    ...(q ? { q } : {}),
    ...(cursor ? { cursor } : {}),
  });
  if (!result.ok)
    error(result.code === 'validation' ? 400 : 403, t(locals.locale, `error.${result.code}`));
  return {
    q,
    paged: cursor !== null,
    items: result.body.items,
    nextCursor: result.body.nextCursor,
  };
};
