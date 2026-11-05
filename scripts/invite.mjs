#!/usr/bin/env node
import { join } from 'node:path';
import { d1Remote, root, runCf } from './lib/cf-child.mjs';
import { readEnvFile } from './lib/env-file.mjs';
import { uuidv7 } from './lib/ids.mjs';
import { siteDefaults } from '../site.config.ts';
import { createAccessPolicy, runInvite } from './lib/invite.mjs';

// `npm run invite -- list | add <email> [--name …] [--role admin] | remove <email>`
// (R-AUTH-18). D1 changes go through cf.mjs, so they hit the configured account only
// (INV-9); the Access policy changes only when .env.cloudflare names it.

const env = readEnvFile(join(root, '.env.cloudflare')) ?? {};

const access =
  env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN && env.ACCESS_POLICY_ID
    ? createAccessPolicy({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        token: env.CLOUDFLARE_API_TOKEN,
        policyId: env.ACCESS_POLICY_ID,
        ...(env.ACCESS_APP_ID ? { appId: env.ACCESS_APP_ID } : {}),
      })
    : null;

try {
  process.exitCode = await runInvite(process.argv.slice(2), {
    d1: (statements) => d1Remote(runCf, statements),
    access,
    uuid: uuidv7,
    // The same `invite.expiryDays` the app reads, so CLI and admin-screen invites agree.
    expiryDays: siteDefaults.invite.expiryDays,
    out: (line) => console.log(line),
  });
} catch (error) {
  console.error(`invite: ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
