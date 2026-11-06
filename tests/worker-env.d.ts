import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MEDIA: R2Bucket;
      CHAT_ROOM: DurableObjectNamespace<
        import('../src/lib/server/adapters/cloudflare/chat-room').ChatRoom
      >;
      TEST_MIGRATIONS: D1Migration[];
      INTERNAL_CONTEXT_KEY: string;
      EXPECTED_SCHEMA: string;
    }
  }
}

export {};
