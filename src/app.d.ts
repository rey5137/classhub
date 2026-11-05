declare global {
  namespace App {
    interface Platform {
      env?: Record<string, unknown>;
      ctx?: unknown;
      caches?: unknown;
      cf?: unknown;
    }
  }
}

export {};
