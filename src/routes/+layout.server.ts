import type { LayoutServerLoad } from './$types';
import { siteConfig } from '$lib/config';
import { navHref, type NavArea } from '$lib/nav';

function isVisible(id: NavArea): boolean {
  if (id === 'home' || id === 'members') return true;
  return siteConfig.features[id];
}

export const load: LayoutServerLoad = ({ locals }) => {
  const nav = siteConfig.nav.filter(isVisible).map((id) => ({ id, href: navHref[id] }));

  return {
    site: { name: siteConfig.name, years: siteConfig.years, appName: siteConfig.appName },
    locale: locals.locale,
    theme: locals.theme,
    mode: locals.mode,
    nav,
  };
};
