import type { PageServerLoad } from './$types';
import { guarded } from '$lib/server/http';
import { homeThreads } from '$lib/server/services/discussions';
import { newestPhotos } from '$lib/server/services/gallery';
import { getInfo, listInfo, renderSiteMarkdown } from '$lib/server/services/info';

// R-BRD-01: Home in its spec order. R-NAV-02: a disabled feature's section is left out
// and its table is never read.
export const load: PageServerLoad = async ({ locals }) => {
  const { member, context } = guarded(locals);
  const { settings, locale } = locals;
  const { features } = settings;
  const [welcomeHtml, info, reunion, photos, threads] = await Promise.all([
    renderSiteMarkdown(context, settings.welcome, features, locale),
    listInfo(context, member),
    getInfo(context, member, { slug: 'reunion' }, features, locale),
    features.memories ? newestPhotos(context, member) : null,
    features.discussions ? homeThreads(context, member) : null,
  ]);
  return {
    greeting: member.displayName,
    welcome: { html: welcomeHtml, bannerMediaId: settings.bannerMediaId },
    // The reunion page has its own card below, so it isn't listed twice.
    pinnedInfo: info.ok
      ? info.body.items
          .filter((page) => page.isPinned && page.slug !== 'reunion')
          .map(({ slug, title }) => ({ slug, title }))
      : [],
    reunion: reunion.ok ? { title: reunion.body.title, bodyHtml: reunion.body.bodyHtml } : null,
    photos,
    threads,
  };
};
