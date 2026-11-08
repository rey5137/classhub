import type { PageServerLoad } from './$types';
import { guarded } from '$lib/server/http';
import { homeThreads } from '$lib/server/services/discussions';
import { newestPhotos } from '$lib/server/services/gallery';
import { getInfo, pinnedInfo, renderSiteMarkdown } from '$lib/server/services/info';

// R-BRD-01: Home in its spec order. R-NAV-02: a disabled feature's section is left out
// and its table is never read.
export const load: PageServerLoad = async ({ locals, url }) => {
  const { member, context } = guarded(locals);
  const { settings, locale } = locals;
  const { features } = settings;
  const pinnedCursor = url?.searchParams.get('pinnedCursor') ?? undefined;
  const [welcomeHtml, pinned, reunion, photos, threads] = await Promise.all([
    renderSiteMarkdown(context, settings.welcome, features, locale),
    pinnedInfo(context, member, pinnedCursor),
    getInfo(context, member, { slug: 'reunion' }, features, locale),
    features.memories ? newestPhotos(context, member) : null,
    features.discussions ? homeThreads(context, member) : null,
  ]);
  return {
    greeting: member.displayName,
    welcome: { html: welcomeHtml, bannerMediaId: settings.bannerMediaId },
    pinnedInfo: pinned.items,
    pinnedInfoNextCursor: pinned.nextCursor,
    reunion: reunion.ok ? { title: reunion.body.title, bodyHtml: reunion.body.bodyHtml } : null,
    photos,
    threads,
  };
};
