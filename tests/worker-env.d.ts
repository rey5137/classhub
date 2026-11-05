import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MEDIA: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
      EXPECTED_SCHEMA: string;
    }
  }
}

export {};
