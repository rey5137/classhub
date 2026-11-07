#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { reason, root, runCf } from './lib/cf-child.mjs';
import { readEnvFile } from './lib/env-file.mjs';

// R-AUTH-33: `npm run access-eval -- key [--rotate]` puts the answer key in the ACCESS_EVAL_KEY Worker
// secret; `npm run access-eval -- rule <https://site-origin>` adds the External Evaluation include
// rule to the Access policy, next to its email rules. Both go through cf.mjs (INV-9).

const [command, arg] = process.argv.slice(2);
const env = readEnvFile(join(root, '.env.cloudflare')) ?? {};

/** @param {string[]} args @param {string} [input] */
function cf(args, input) {
  const result = runCf(args, input === undefined ? {} : { input });
  if (result.status !== 0) throw new Error(reason(result));
  return result.stdout;
}

function key() {
  const listed = JSON.parse(cf(['secret', 'list', '--format', 'json']));
  const exists =
    Array.isArray(listed) && listed.some((secret) => secret?.name === 'ACCESS_EVAL_KEY');
  if (exists && arg !== '--rotate') {
    console.log('ACCESS_EVAL_KEY is already set; pass --rotate to replace it.');
    return;
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // The key goes in on stdin only and is never printed.
  cf(['secret', 'put', 'ACCESS_EVAL_KEY'], JSON.stringify(privateKey.export({ format: 'jwk' })));
  console.log('ACCESS_EVAL_KEY set.');
}

function rule() {
  if (!env.ACCESS_POLICY_ID) throw new Error('.env.cloudflare has no ACCESS_POLICY_ID');
  const origin = new URL(arg ?? '').origin;
  if (!origin.startsWith('https://')) throw new Error('usage: rule <https://site-origin>');
  const path = env.ACCESS_APP_ID
    ? `/access/apps/${env.ACCESS_APP_ID}/policies/${env.ACCESS_POLICY_ID}`
    : `/access/policies/${env.ACCESS_POLICY_ID}`;
  const policy = JSON.parse(cf(['api', path]));
  /** @type {Array<{ external_evaluation?: unknown } | null>} */
  const include = Array.isArray(policy.include) ? policy.include : [];
  const others = include.filter((entry) => !entry?.external_evaluation);
  const evaluation = {
    external_evaluation: {
      evaluate_url: `${origin}/access-eval`,
      keys_url: `${origin}/access-eval/keys`,
    },
  };
  cf(
    ['api', '--put', path],
    JSON.stringify({
      name: policy.name,
      decision: policy.decision,
      include: [...others, evaluation],
      exclude: policy.exclude ?? [],
      require: policy.require ?? [],
      ...(policy.precedence === undefined ? {} : { precedence: policy.precedence }),
    }),
  );
  console.log(`External Evaluation rule set: ${origin}/access-eval`);
}

try {
  if (command === 'key') key();
  else if (command === 'rule') rule();
  else throw new Error('usage: access-eval key [--rotate] | rule <https://site-origin>');
} catch (error) {
  console.error(`access-eval: ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
