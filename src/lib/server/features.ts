import { error } from '@sveltejs/kit';
import type { Feature, Features } from '../contracts/settings';
import { t } from '../i18n';

/**
 * R-NAV-02: the one map from a route to the admin feature flag that owns it.
 * Memories owns its pages, albums and the gallery list. The upload reservations, the
 * byte route and `/api/v1/media/:id` also carry avatars and site media (banner, logo,
 * favicon), so they stay open and the media services refuse only a gallery photo there.
 */
const FEATURE_ROUTES: [RegExp, Feature][] = [
  [/^\/memories(\/|$)/, 'memories'],
  [/^\/api\/v1\/albums(\/|$)/, 'memories'],
  [/^\/api\/v1\/media$/, 'memories'],
  [/^\/discussions(\/|$)/, 'discussions'],
  [/^\/api\/v1\/(posts|comments)(\/|$)/, 'discussions'],
  [/^\/chat(\/|$)/, 'chat'],
  [/^\/api\/v1\/chat(\/|$)/, 'chat'],
  [/^\/notifications(\/|$)/, 'notifications'],
  [/^\/api\/v1\/notifications(\/|$)/, 'notifications'],
];

/**
 * What the map is matched against: the route SvelteKit matched (`/api/v1/posts/[id]`),
 * so a percent-encoded path (`/api/v1/p%6Fsts`) can't slip past it. An unmatched
 * request (a 404, or a feature's API not built yet) falls back to its decoded path.
 */
export function routeKey(routeId: string | null, path: string): string {
  if (routeId) return routeId;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** The feature a route key belongs to, or null for a route every member always has. */
export function featureOf(path: string): Feature | null {
  return FEATURE_ROUTES.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

/** The disabled feature a route key belongs to, or null when the route is available. */
export function disabledFeature(path: string, features: Features): Feature | null {
  const feature = featureOf(path);
  return feature && !features[feature] ? feature : null;
}

/**
 * R-NAV-02: a disabled feature's page is a 404. Each feature's own route folder calls
 * this from every page load itself, since SvelteKit can skip a layout load on a
 * `__data.json` navigation; it reads only `locals`. API and form posts are refused
 * earlier, in the pipeline.
 */
export function requireFeature(locals: App.Locals, feature: Feature): void {
  if (!locals.settings.features[feature]) error(404, t(locals.locale, 'error.not_found'));
}
