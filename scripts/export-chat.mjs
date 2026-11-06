#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { siteConfig } from '../src/lib/config/index.ts';
import { openChatDatabase, parseChatArgs } from './lib/chat-target.mjs';
import { readEnvFile } from './lib/env-file.mjs';
import { runExportChat } from './lib/export-chat.mjs';
import { cleanUpOnSignals } from './lib/verify-backup.mjs';

// R-BAK-05: the identity decrypts each written file once to verify it; it is not kept with them.
const usage = `usage: npm run export-chat -- [--local] [--out <dir>] [--recipient age1…] [--identity <key.txt>]
  --identity (or AGE_IDENTITY_FILE) is used for this run only, to read each written archive back;
  keep it away from the archives, never stored next to them.`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  // A signal must not leave plaintext staging, a partial file or the lock behind (R-BAK-05).
  cleanUpOnSignals('export-chat');
  const options = parseChatArgs(process.argv.slice(2), ['--out', '--recipient', '--identity']);
  if (!options) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    const target = openChatDatabase('export-chat', root, options);
    if (target) {
      try {
        process.exitCode = await runExportChat({
          database: target.database,
          policy: siteConfig.chat,
          recipient:
            options.values['--recipient'] ??
            readEnvFile(join(root, '.env.cloudflare'))?.AGE_RECIPIENT,
          identity: options.values['--identity'] ?? (process.env.AGE_IDENTITY_FILE || undefined),
          outDir: resolve(options.values['--out'] ?? join(root, 'backups')),
        });
      } finally {
        target.close();
      }
    }
  }
}
