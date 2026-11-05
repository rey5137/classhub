#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { getRandomValues } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './lib/env-file.mjs';
import { siteDefaults } from '../site.config.ts';
import { createAccessPolicy, runInvite } from './lib/invite.mjs';

// `npm run invite -- list | add <email> [--name …] [--role admin] | remove <email>`
// (R-AUTH-18). D1 changes go through cf.mjs, so they hit the configured account only
// (INV-9); the Access policy changes only when .env.cloudflare names it.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = readEnvFile(join(root, '.env.cloudflare')) ?? {};

/** §5.1 ids: UUIDv7 (48-bit ms timestamp, version and variant bits, random rest). */
function uuidv7() {
  const bytes = getRandomValues(new Uint8Array(16));
  const now = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((now >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {string[]} statements */
async function d1(statements) {
  // The token never rides in argv or this child's env: cf.mjs reads .env.cloudflare itself.
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('CLOUDFLARE_')),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'cf.mjs'),
      'd1',
      'execute',
      'DB',
      '--remote',
      '--json',
      '--command',
      statements.join(';\n'),
    ],
    { cwd: root, env: childEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`cannot run cf.mjs: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`d1 execute failed (exit ${result.status})`);
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(
    (entry) => /** @type {Record<string, unknown>[]} */ (entry?.results ?? []),
  );
}

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
    d1,
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
