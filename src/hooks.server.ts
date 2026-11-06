import { sequence } from '@sveltejs/kit/hooks';
import { appearance, applyAppearance } from '$lib/server/appearance';
import { createContext } from '$lib/server/context';
import { createSecurityHandle, handleServerError } from '$lib/server/pipeline';

export const handle = sequence(
  appearance,
  createSecurityHandle({
    getContext: (event) => createContext(event.platform, event.url.origin),
    production: !import.meta.env.DEV,
    onSettings: applyAppearance,
  }),
);

export const handleError = handleServerError;
