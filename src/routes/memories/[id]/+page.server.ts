import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { requireFeature } from '$lib/server/features';
import { formFailure, formText, guarded } from '$lib/server/http';
import { can } from '$lib/server/auth/permissions';
import { deletePhoto, editPhoto, getPhoto, listAlbumsPage } from '$lib/server/services/gallery';

// §7.2 /memories/[id]: an unknown, deleted or malformed id is one "not found", so the
// page never says which (R-MEM-20).
export const load: PageServerLoad = async ({ locals, params, url }) => {
  requireFeature(locals, 'memories');
  const { member, context } = guarded(locals);
  const photo = await getPhoto(context, member, params.id);
  if (!photo) error(404, t(locals.locale, 'error.not_found'));
  const albumsCursor = url?.searchParams.get('albumsCursor') ?? undefined;
  const albumsPage = photo.canEdit
    ? await listAlbumsPage(context, member, albumsCursor ? { cursor: albumsCursor } : {})
    : { ok: true as const, status: 200, body: { items: [], nextCursor: null } };
  if (!albumsPage.ok) error(400, t(locals.locale, 'error.validation'));
  const albums = [...albumsPage.body.items];
  // The select pages 50 albums at a time; the photo's own is always one of them, or a
  // caption-only save would post "no album" and move the photo out (R-MEM-14).
  if (photo.album && !albums.some((album) => album.id === photo.album!.id))
    albums.push({ ...photo.album, yearTag: null, description: null, canEdit: false });
  return {
    photo,
    canDelete: can(member, 'content.delete', { ownerId: photo.uploader.id }),
    albums,
    albumsNextCursor: albumsPage.body.nextCursor,
  };
};

export const actions: Actions = {
  edit: async ({ locals, params, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const caption = formText(form, 'caption')?.trim();
    const albumId = formText(form, 'albumId');
    // A form without the album field leaves the album as it is.
    const result = await editPhoto(
      context,
      member,
      { id: params.id },
      { caption: caption || null, ...(albumId === undefined ? {} : { albumId: albumId || null }) },
      locals.settings.features,
    );
    if (!result.ok) return formFailure('edit', locals, result);
    return { action: 'edit', done: 'saved' };
  },
  delete: async ({ locals, params }) => {
    const { member, context } = guarded(locals);
    const result = await deletePhoto(context, member, { id: params.id }, locals.settings.features);
    if (!result.ok) return formFailure('delete', locals, result);
    redirect(303, '/memories');
  },
};
