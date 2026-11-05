import { json } from '@sveltejs/kit';
import { version } from '../../../package.json';

export const prerender = false;

// R-API-05: no member, setting or count belongs in this payload.
export function GET() {
  return json({ ok: true, version }, { headers: { 'cache-control': 'no-store' } });
}
