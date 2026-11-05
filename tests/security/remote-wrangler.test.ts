import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// `wrangler` as a command, but not `node_modules/.bin/wrangler` paths? It is a
// command there too; `.wrangler/` paths and wrangler config filenames are not.
const remoteCall = /(?<!\.)\bwrangler\b(?!\.(?:jsonc?|toml)\b)/;

interface Source {
  file: string;
  source: string;
}

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(full) : [full];
  });
}

function sources(): Source[] {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  return [
    ...Object.entries(packageJson.scripts ?? {}).map(([name, source]) => ({
      file: `package.json#scripts.${name}`,
      source,
    })),
    ...collectFiles(join(repoRoot, 'scripts')).map((path) => ({
      file: relative(repoRoot, path),
      source: readFileSync(path, 'utf8'),
    })),
    ...collectFiles(join(repoRoot, '.github', 'workflows'))
      .filter((path) => /\.ya?ml$/.test(path))
      .map((path) => ({
        file: relative(repoRoot, path),
        source: readFileSync(path, 'utf8'),
      })),
  ];
}

describe('remote wrangler calls', () => {
  it('AC-PLAT-07 keeps them inside scripts/cf.mjs', () => {
    const scanned = sources();

    // The guard itself must be visible, or an empty scan would pass vacuously.
    const guard = scanned.find((source) => source.file === 'scripts/cf.mjs');
    expect(guard?.source).toMatch(remoteCall);

    const offenders = scanned.filter(
      (source) => source.file !== 'scripts/cf.mjs' && remoteCall.test(source.source),
    );
    expect(offenders.map((source) => source.file)).toEqual([]);
  });

  it.each([
    "spawnSync('wrangler', ['deploy'])",
    'spawnSync("wrangler", ["deploy"])',
    'npm exec wrangler deploy',
    'npx wrangler deploy',
    'npx -y wrangler@4 deploy',
    'node_modules/.bin/wrangler deploy',
    'wrangler',
    '#!/bin/sh\nwrangler deploy',
    'await $`wrangler deploy`',
  ])('detects the bypass sample %j', (source) => {
    expect(remoteCall.test(source)).toBe(true);
  });

  it.each(['.wrangler/tmp/wrangler.jsonc', 'wrangler.jsonc', 'wrangler.toml'])(
    'does not flag the non-command %j',
    (source) => {
      expect(remoteCall.test(source)).toBe(false);
    },
  );
});
