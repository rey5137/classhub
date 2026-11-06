#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChatTargetError, chatDatabase, parseChatArgs } from './lib/chat-target.mjs';
import { runPruneChat } from './lib/prune-chat.mjs';
import { cleanUpOnSignals } from './lib/verify-backup.mjs';

const usage = 'usage: npm run prune-chat -- [--local]';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  // A signal must not leave the backup lock behind (R-BAK-03).
  cleanUpOnSignals('prune-chat');
  const options = parseChatArgs(process.argv.slice(2), []);
  if (!options) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    let target;
    try {
      target = chatDatabase(root, { local: options.local });
    } catch (error) {
      // Zod and parse errors can echo .env.cloudflare values; say what to check instead.
      console.error(
        error instanceof ChatTargetError
          ? `prune-chat: ${error.message}`
          : 'prune-chat: needs wrangler.jsonc (npm run setup) and CLOUDFLARE_ACCOUNT_ID in .env.cloudflare matching it, or --local.',
      );
      process.exitCode = 1;
    }
    if (target) {
      try {
        process.exitCode = await runPruneChat({ database: target.database });
      } finally {
        target.close();
      }
    }
  }
}
