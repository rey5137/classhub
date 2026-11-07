import type { LayoutServerLoad } from './$types';
import { siteConfig } from '$lib/config';
import { navHref, type NavArea } from '$lib/nav';
import { storageWarning } from '$lib/server/services/gallery';

export const load: LayoutServerLoad = async ({ locals, route }) => {
  const { settings } = locals;
  // R-NAV-02: a disabled feature leaves the nav; its pages 404 in their own layouts.
  const isVisible = (id: NavArea) => id === 'home' || id === 'members' || settings.features[id];
  // R-AUTH-27/32: the pages outside Access show the site name and themselves, nothing to navigate to.
  const publicPage = route.id === '/join' || route.id === '/privacy';
  const nav = publicPage
    ? []
    : siteConfig.nav.filter(isVisible).map((id) => ({ id, href: navHref[id] }));

  return {
    site: {
      name: settings.name,
      years: settings.years,
      appName: siteConfig.appName,
      // Site media is private (§7): public pages keep the shipped mark.
      logoMediaId: locals.member ? settings.logoMediaId : null,
    },
    // The account button shows the member's own avatar or initials; nothing on public pages.
    me: locals.member
      ? { name: locals.member.displayName, avatarMediaId: locals.member.avatarMediaId ?? null }
      : null,
    features: settings.features,
    locale: locals.locale,
    timeZone: locals.timeZone,
    theme: locals.theme,
    mode: locals.mode,
    nav,
    publicPage,
    // R-MEM-15: one D1 read, for admins only; public pages and members skip it.
    storageWarning:
      locals.member && locals.context ? await storageWarning(locals.context, locals.member) : false,
  };
};
