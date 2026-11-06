import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { joinRequests, siteSettings } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/ports/database';
import type { TurnstileVerifier } from '../../src/lib/server/services/turnstile';
import { load as layoutLoad } from '../../src/routes/+layout.server';
import { actions, load } from '../../src/routes/join/+page.server';
import { ORIGIN } from './pipeline-harness';

// Stands in for SvelteKit rendering `/join`: the real root layout load, the real page
// load and, on a POST, the real form action. The page is a function of exactly these,
// so the JSON is serialised into a nonced page as nonce mode would emit it.

type Load = (event: RequestEvent) => Promise<unknown>;
type Action = (event: RequestEvent) => Promise<unknown>;

export const GOOD_TOKEN = 'turnstile-ok';

/** Accepts one token only, so a test can send a bad one. */
export const stubTurnstile: TurnstileVerifier = {
  siteKey: '1x00000000000000000000AA',
  async verify(token) {
    return token === GOOD_TOKEN;
  },
};

export async function renderJoin(event: RequestEvent): Promise<Response> {
  if (event.url.pathname !== '/join') return new Response('no route', { status: 404 });
  let form: unknown = null;
  let status = 200;
  if (event.request.method === 'POST') {
    const result = (await (actions.default as unknown as Action)(event)) as {
      status?: number;
      data?: unknown;
    };
    // An ActionFailure carries its status and data; a success is the returned object.
    const failed = result && typeof result.status === 'number' && 'data' in result;
    form = failed ? result.data : result;
    status = failed ? (result.status as number) : 200;
  }
  const page = {
    layout: await (layoutLoad as unknown as Load)(event),
    data: await (load as unknown as Load)(event),
    form,
    member: event.locals.member,
  };
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html><head><script nonce="${nonce}">${JSON.stringify(page)}</script></head><body></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html',
        'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; frame-ancestors 'none'`,
      },
    },
  );
}

/** The rendered page's state, for assertions. */
export async function pageState(response: Response) {
  const html = await response.text();
  const json = /<script nonce="[^"]+">(.*)<\/script>/.exec(html)?.[1] ?? 'null';
  return JSON.parse(json) as {
    layout: Record<string, unknown>;
    data: { closed: boolean; turnstile: { siteKey: string; script: string } | null };
    form: Record<string, unknown> | null;
    member: unknown;
  };
}

export function joinForm(fields: Record<string, string>): {
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  return {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

export async function setJoin(database: Database, on: boolean): Promise<void> {
  const value = JSON.stringify({ memories: true, discussions: true, chat: true, join: on });
  await database.db
    .insert(siteSettings)
    .values({ key: 'features', valueJson: value })
    .onConflictDoUpdate({ target: siteSettings.key, set: { valueJson: value } });
}

export async function storedRequests(database: Database) {
  return database.db.select().from(joinRequests).orderBy(joinRequests.createdAt);
}

export async function clearRequests(database: Database, email?: string) {
  await (email
    ? database.db.delete(joinRequests).where(eq(joinRequests.email, email))
    : database.db.delete(joinRequests));
}
