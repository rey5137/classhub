import type { APIRequestContext } from '@playwright/test';

/** `/members/member-demo` stands for a seeded classmate, whose id the seed draws at random. */
export const MEMBER_DEMO = '/members/member-demo';

/** The demo classmate Mai Nguyen's page, looked up through the directory API. */
export async function demoMemberPath(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/members?q=mai');
  const body = (await response.json()) as { items: { id: string; displayName: string }[] };
  const mai = body.items.find((item) => item.displayName === 'Mai Nguyen');
  if (!mai) throw new Error('the demo seed has no Mai Nguyen');
  return `/members/${mai.id}`;
}

/** `/memories/photo-demo` stands for a photo seed-demo.ts paints into its first album. */
export const PHOTO_DEMO = '/memories/photo-demo';

export async function demoPhotoPath(request: APIRequestContext): Promise<string> {
  const albums = (await (await request.get('/api/v1/albums')).json()) as {
    items: { id: string; name: string }[];
  };
  const album = albums.items.find((item) => item.name === 'Dã ngoại Ba Vì');
  if (!album) throw new Error('the demo seed has no Ba Vi album');
  const page = (await (await request.get(`/api/v1/media?album=${album.id}`)).json()) as {
    items: { id: string; caption: string | null }[];
  };
  const photo = page.items.find((item) => item.caption === 'Lều xanh bên suối');
  if (!photo) throw new Error('the demo seed has no painted photo');
  return `/memories/${photo.id}`;
}

/** `/discussions/thread-demo` stands for the seeded thread with comments and a photo. */
export const THREAD_DEMO = '/discussions/thread-demo';
export const DEMO_THREAD_TITLE = 'Ai còn giữ ảnh chuyến dã ngoại Ba Vì?';

export async function demoThreadPath(request: APIRequestContext): Promise<string> {
  const page = (await (await request.get('/api/v1/posts')).json()) as {
    items: { id: string; title: string }[];
  };
  const thread = page.items.find((item) => item.title === DEMO_THREAD_TITLE);
  if (!thread) throw new Error('the demo seed has no demo thread');
  return `/discussions/${thread.id}`;
}

export async function routePath(request: APIRequestContext, route: string): Promise<string> {
  if (route === MEMBER_DEMO) return demoMemberPath(request);
  if (route === THREAD_DEMO) return demoThreadPath(request);
  return route === PHOTO_DEMO ? demoPhotoPath(request) : route;
}
