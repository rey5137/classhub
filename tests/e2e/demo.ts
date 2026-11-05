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

export async function routePath(request: APIRequestContext, route: string): Promise<string> {
  return route === MEMBER_DEMO ? demoMemberPath(request) : route;
}
