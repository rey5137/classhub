import type { PageServerLoad } from './$types';
import { guarded } from '$lib/server/http';
import { can } from '$lib/server/auth/permissions';
import { albumChoices } from '$lib/server/services/media';

// §7.2: what the upload sheet needs; the photo wall itself is built in 2c.
export const load: PageServerLoad = async ({ locals }) => {
  const { member, context } = guarded(locals);
  return {
    canUpload: can(member, 'content.create'),
    albums: await albumChoices(context, member),
  };
};
