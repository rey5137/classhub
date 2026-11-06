import type { RequestHandler } from './$types';
import { siteConfig } from '$lib/config';
import { themeColorFor } from '$lib/themes/registry';

export const prerender = false;

const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

// R-NAV-07: public (Access Bypass), so it carries the site name, language and colours and
// nothing about a member, a count or any other setting.
export const GET: RequestHandler = ({ locals }) => {
  const { settings } = locals;
  const bg = themeColorFor(settings.theme, settings.mode);
  const body = {
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    name: settings.name,
    short_name: siteConfig.shortName ?? settings.name,
    lang: settings.locale,
    theme_color: bg,
    background_color: bg,
    icons: ICONS,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/manifest+json',
      'cache-control': 'private, no-store',
    },
  });
};
