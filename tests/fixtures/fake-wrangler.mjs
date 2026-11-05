#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const token = process.env.CLOUDFLARE_API_TOKEN ?? null;
const log = process.env.FAKE_WRANGLER_LOG;
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({
      args,
      hasAccountId: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID),
      hasToken: Boolean(token),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
      token,
      cloudflareEnv: Object.keys(process.env).filter((key) => key.startsWith('CLOUDFLARE_')),
      home: process.env.HOME ?? null,
      xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
    })}\n`,
  );
}

if (args[0] === 'whoami') {
  process.stdout.write(process.env.FAKE_WRANGLER_WHOAMI ?? '');
  if (process.env.FAKE_WRANGLER_WHOAMI_EXIT) {
    process.exitCode = Number(process.env.FAKE_WRANGLER_WHOAMI_EXIT);
  }
} else if (process.env.FAKE_WRANGLER_EXIT) {
  process.exitCode = Number(process.env.FAKE_WRANGLER_EXIT);
}
