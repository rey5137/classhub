#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { root, runCf } from './lib/cf-child.mjs';
import { uuidv7 } from './lib/ids.mjs';
import { runSetup, SetupError } from './lib/setup.mjs';

// `npm run setup [-- --slug x --title "…" --theme t --locale l --admin a@b.c]`
// (R-OPS-04). A flag answers its prompt; without a terminal the prompt's default
// stands, and a question with no default (the admin email) needs its flag.

const flags = /** @type {Record<string, string>} */ ({});
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const match = /^--(slug|title|theme|locale|admin)(?:=(.*))?$/.exec(argv[index] ?? '');
  if (!match) {
    console.error(`setup: unknown argument ${argv[index]}`);
    process.exit(1);
  }
  flags[match[1] ?? ''] = match[2] ?? argv[++index] ?? '';
}
const terminal = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : null;

/** @param {{ key: string; question: string; fallback: string }} prompt */
async function ask({ key, question, fallback }) {
  if (flags[key] !== undefined) return flags[key];
  if (!terminal) {
    if (fallback) return fallback;
    throw new SetupError(`no terminal to ask "${question}"; pass --${key}.`);
  }
  const answer = await terminal.question(`${question}${fallback ? ` [${fallback}]` : ''}: `);
  return answer.trim() || fallback;
}

try {
  process.exitCode = await runSetup({
    run: runCf,
    ask,
    out: (line) => console.log(line),
    root,
    nodeVersion: process.versions.node,
    uuid: uuidv7,
    secret: () => randomBytes(32).toString('base64url'),
  });
} catch (error) {
  console.error(
    `setup: ${error instanceof SetupError ? error.message : error instanceof Error ? error.message : 'failed'}`,
  );
  process.exitCode = 1;
} finally {
  terminal?.close();
}
