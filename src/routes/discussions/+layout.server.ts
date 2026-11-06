import type { LayoutServerLoad } from './$types';
import { requireFeature } from '$lib/server/features';

export const load: LayoutServerLoad = ({ locals }) => {
  requireFeature(locals, 'discussions');
};
