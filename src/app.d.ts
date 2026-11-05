/// <reference types="vite/client" />
import type { Locale } from '$lib/i18n';
import type { RenderedMode, ThemeId } from '$lib/themes/theme-tokens';

declare global {
  namespace App {
    interface Locals {
      theme: ThemeId;
      mode: RenderedMode;
      locale: Locale;
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
