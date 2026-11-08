/// <reference types="vite/client" />
import type { SiteSettings } from '$lib/contracts/settings';
import type { Locale } from '$lib/i18n';
import type { Member } from '$lib/server/auth/membership';
import type { AppContext } from '$lib/server/context';
import type { RenderedMode, ThemeId } from '$lib/themes/theme-tokens';

declare global {
  namespace App {
    interface Locals {
      theme: ThemeId;
      mode: RenderedMode;
      locale: Locale;
      /** R-UI-11: the viewer's `tz` cookie when valid, else the Level B `timeZone`. */
      timeZone: string;
      /** R-UI-01: the effective site settings, read once per request (Level B until the read). */
      settings: SiteSettings;
      /** R-AUTH-12: from the same read; false until it happens. */
      setupUnlocked: boolean;
      /** R-PLAT-01: set by hooks.server.ts only after identity and an active membership. */
      member: Member | null;
      /** R-BUD-05: `handleServerError` saw a D1 failure; the pipeline answers `unavailable`. */
      storageFailed?: boolean;
      /** R-CHAT-04: the verified session's end (the Access JWT's `exp`), in ms; set with `member`. */
      authUntil?: number;
      /** The adapters the guard used; set before identity, so only guarded routes read it. */
      context?: AppContext;
      /** R-AUTH-20/27: set on `/join` while join requests are on; only then may its CSP admit Turnstile. */
      joinOpen?: boolean;
      /** R-AUTH-29: the stable salt for `/join`'s IP hash; unset in a production build without `LOG_HASH_SALT`. */
      joinSalt?: string;
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
