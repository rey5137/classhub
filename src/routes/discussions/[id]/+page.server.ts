import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { requireFeature } from '$lib/server/features';
import { can } from '$lib/server/auth/permissions';
import { bodyView, formFailure, formText, guarded } from '$lib/server/http';
import {
  commentPageCursor,
  createComment,
  deleteComment,
  deletePost,
  editComment,
  editPost,
  getThreadWithComments,
} from '$lib/server/services/discussions';

// §7.2 /discussions/[id]: an unknown, deleted or malformed id is one "not found", so the
// page never says which. Comments page forward with a keyset cursor (R-BRD-07).
export const load: PageServerLoad = async ({ locals, params, url }) => {
  requireFeature(locals, 'discussions');
  const { member, context } = guarded(locals);
  const cursor = url.searchParams.get('cursor');
  const thread = await getThreadWithComments(
    context,
    member,
    { id: params.id },
    cursor ? { cursor } : {},
    bodyView(locals),
  );
  if (!thread.ok) {
    if (thread.code === 'validation') error(400, t(locals.locale, 'error.validation'));
    error(404, t(locals.locale, 'error.not_found'));
  }
  const { post, comments } = thread.body;
  return {
    post,
    comments: comments.items,
    nextCursor: comments.nextCursor,
    // The page's forms post back to this page, so a failed or done action re-renders it.
    cursor,
    paged: Boolean(cursor),
    // R-BRD-07: a locked thread takes no comment from anyone, admins included.
    canComment: can(member, 'content.create') && !post.isLocked,
  };
};

/** A refusal that keeps the typed text and names the row it came from. */
function refused(
  action: string,
  locals: App.Locals,
  result: Parameters<typeof formFailure>[2],
  values: Record<string, string>,
  target?: string,
) {
  const failure = formFailure(action, locals, result, target);
  return fail(failure.status, { ...failure.data, values });
}

export const actions: Actions = {
  comment: async ({ locals, params, request }) => {
    const { member, context } = guarded(locals);
    const body = formText(await request.formData(), 'body') ?? '';
    const result = await createComment(
      context,
      member,
      { id: params.id },
      { body },
      bodyView(locals),
    );
    // The 423 of a thread locked while the form was open reads as a form error too.
    if (!result.ok) return refused('comment', locals, result, { body });
    // Post/Redirect/Get: a refresh never posts twice; the page that holds the comment opens at it.
    const cursor = await commentPageCursor(context, result.body);
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    redirect(303, `/discussions/${params.id}${query}#comment-${result.body.id}`);
  },
  editPost: async ({ locals, params, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const values = { title: formText(form, 'title') ?? '', body: formText(form, 'body') ?? '' };
    const result = await editPost(context, member, { id: params.id }, values, bodyView(locals));
    if (!result.ok) return refused('editPost', locals, result, values);
    return { action: 'editPost', done: 'saved' };
  },
  deletePost: async ({ locals, params }) => {
    const { member, context } = guarded(locals);
    const result = await deletePost(context, member, { id: params.id });
    if (!result.ok) return formFailure('deletePost', locals, result);
    redirect(303, '/discussions');
  },
  // R-BRD-08: pin and lock are admin moderation; the service refuses anyone else.
  pin: async ({ locals, params, request }) => {
    const { member, context } = guarded(locals);
    const isPinned = formText(await request.formData(), 'value') === 'true';
    const result = await editPost(
      context,
      member,
      { id: params.id },
      { isPinned },
      bodyView(locals),
    );
    if (!result.ok) return formFailure('pin', locals, result);
    return { action: 'pin', done: isPinned ? 'pinned' : 'unpinned' };
  },
  lock: async ({ locals, params, request }) => {
    const { member, context } = guarded(locals);
    const isLocked = formText(await request.formData(), 'value') === 'true';
    const result = await editPost(
      context,
      member,
      { id: params.id },
      { isLocked },
      bodyView(locals),
    );
    if (!result.ok) return formFailure('lock', locals, result);
    return { action: 'lock', done: isLocked ? 'locked' : 'unlocked' };
  },
  editComment: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const id = formText(form, 'commentId') ?? '';
    const body = formText(form, 'body') ?? '';
    const result = await editComment(context, member, { id }, { body }, bodyView(locals));
    if (!result.ok) return refused('editComment', locals, result, { body }, id);
    return { action: 'editComment', done: 'commentSaved', target: id };
  },
  deleteComment: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const id = formText(await request.formData(), 'commentId') ?? '';
    const result = await deleteComment(context, member, { id });
    if (!result.ok) return formFailure('deleteComment', locals, result, id);
    return { action: 'deleteComment', done: 'commentDeleted', target: id };
  },
};
