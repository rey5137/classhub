/// <reference types="vite/client" />
import type { Locale } from '$lib/i18n';
import type { Member } from '$lib/server/auth/membership';
import type { RenderedMode, ThemeId } from '$lib/themes/theme-tokens';

declare global {
  namespace App {
    interface Locals {
      theme: ThemeId;
      mode: RenderedMode;
      locale: Locale;
      /** R-PLAT-01: set by hooks.server.ts only after identity and an active membership. */
      member: Member | null;
      requestId: string;
    }

    interface Error {
      message: string;
      requestId?: string;
    }

    interface Platform {
      env?: Record<string, unknown>;
      ctx?: unknown;
      caches?: unknown;
      cf?: unknown;
    }
  }
}

export {};
