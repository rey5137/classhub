import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { can } from '$lib/server/auth/permissions';
import { bodyView, formFailure, formText, guarded } from '$lib/server/http';
import { createPost, listPosts } from '$lib/server/services/discussions';

// R-BRD-06: the board reads its cursor from the query string, so "older threads" is a
// plain link that works without JS; there is no offset paging.
export const load: PageServerLoad = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  const cursor = url.searchParams.get('cursor');
  const page = await listPosts(context, member, cursor ? { cursor } : {});
  if (!page.ok) error(400, t(locals.locale, 'error.validation'));
  return {
    threads: page.body.items,
    nextCursor: page.body.nextCursor,
    paged: Boolean(cursor),
    canCreate: can(member, 'content.create'),
  };
};

export const actions: Actions = {
  // R-AUTH-17: a plain form post; a refusal keeps what was typed, since without JS the
  // browser renders the page afresh.
  create: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const input = { title: formText(form, 'title') ?? '', body: formText(form, 'body') ?? '' };
    const result = await createPost(context, member, input, bodyView(locals));
    if (!result.ok) {
      const failure = formFailure('create', locals, result);
      return fail(failure.status, { ...failure.data, values: input });
    }
    redirect(303, `/discussions/${result.body.id}`);
  },
};
