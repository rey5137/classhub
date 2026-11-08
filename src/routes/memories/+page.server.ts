import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import { requireFeature } from '$lib/server/features';
import { guarded, formFailure, formText } from '$lib/server/http';
import { can } from '$lib/server/auth/permissions';
import {
  createAlbum,
  editAlbum,
  getAlbumChoice,
  listAlbumsPage,
  listPhotos,
  listYears,
} from '$lib/server/services/gallery';

// R-MEM-14: the wall reads its filters and cursor from the query string, so every
// filter and the next page are plain links that work without JS.
export const load: PageServerLoad = async ({ locals, url }) => {
  requireFeature(locals, 'memories');
  const { member, context } = guarded(locals);
  const query: Record<string, string> = {};
  for (const name of ['album', 'year', 'cursor']) {
    const value = url.searchParams.get(name);
    if (value) query[name] = value;
  }
  const albumsCursor = url.searchParams.get('albumsCursor');
  const [page, albumsPage, years] = await Promise.all([
    listPhotos(context, member, query),
    listAlbumsPage(context, member, albumsCursor ? { cursor: albumsCursor } : {}),
    listYears(context, member),
  ]);
  if (!page.ok || !albumsPage.ok) error(400, t(locals.locale, 'error.validation'));
  const albums = [...albumsPage.body.items];
  if (query.album && !albums.some((album) => album.id === query.album)) {
    const active = await getAlbumChoice(context, member, query.album);
    if (active) albums.push(active);
  }
  return {
    canUpload: can(member, 'content.create'),
    photos: page.body.items,
    nextCursor: page.body.nextCursor,
    albums,
    albumsNextCursor: albumsPage.body.nextCursor,
    years,
    filter: {
      album: query.album ?? null,
      year: query.year ? Number(query.year) : null,
      paged: Boolean(query.cursor),
    },
  };
};

/** An album form as the API's body: blank year and description clear them. */
function albumInput(form: FormData) {
  const yearTag = formText(form, 'yearTag')?.trim();
  const description = formText(form, 'description')?.trim();
  return {
    name: formText(form, 'name'),
    yearTag: yearTag ? (/^\d+$/.test(yearTag) ? Number(yearTag) : yearTag) : null,
    description: description || null,
  };
}

export const actions: Actions = {
  createAlbum: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const result = await createAlbum(context, member, albumInput(await request.formData()));
    if (!result.ok) return formFailure('createAlbum', locals, result);
    redirect(303, `/memories?album=${result.body.id}`);
  },
  editAlbum: async ({ locals, request }) => {
    const { member, context } = guarded(locals);
    const form = await request.formData();
    const result = await editAlbum(context, member, { id: formText(form, 'id') }, albumInput(form));
    if (!result.ok) return formFailure('editAlbum', locals, result);
    return { action: 'editAlbum', done: 'albumSaved' };
  },
};
