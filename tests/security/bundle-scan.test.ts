import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// AC-PLAT-05 (R-PLAT-01, 09): no private route is prerendered and the built
// client bundle carries no fixture or demo member data. The build runs here so
// the scan stays in `test:security`, which verify runs before `build`.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const clientDir = join(repoRoot, '.svelte-kit/output/client');
const routesDir = join(repoRoot, 'src/routes');

// The only routes allowed to render without identity (spec §6.3, R-NAV-07).
const PUBLIC = new Set(['health', 'manifest.webmanifest', 'denied', 'locked', 'privacy']);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function routeOf(file: string): string {
  return relative(routesDir, file)
    .replace(/\/?\+[^/]*\.ts$/, '')
    .replaceAll('\\', '/');
}

function publicRoute(route: string): boolean {
  return PUBLIC.has(route.split('/')[0] ?? '');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function exampleEmails(source: string): string[] {
  return unique(
    [...source.matchAll(/['"`]([^'"`\s]+@example\.(?:com|test))['"`]/g)].map((match) => match[1]!),
  );
}

beforeAll(() => {
  // Vitest sets NODE_ENV=test and VITEST*; a child build must not inherit them.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    env,
    stdio: 'ignore',
    timeout: 180_000,
  });
}, 240_000);

describe('AC-PLAT-05 build output', () => {
  it('AC-PLAT-05 does not prerender any private route', () => {
    const prerendered = walk(routesDir)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        const value = source.match(/export const prerender\s*=\s*([^;\n]+)/)?.[1]?.trim();
        return value && value !== 'false' && !publicRoute(routeOf(file))
          ? [`${routeOf(file) || '/'} (${value})`]
          : [];
      });
    expect(prerendered).toEqual([]);

    const pages = join(repoRoot, '.svelte-kit/output/prerendered/pages');
    if (existsSync(pages)) {
      const privatePages = walk(pages)
        .filter((file) => file.endsWith('.html'))
        .map((file) =>
          relative(pages, file)
            .replace(/\/?index\.html$/, '')
            .replace(/\.html$/, ''),
        )
        .filter((route) => !publicRoute(route));
      expect(privatePages).toEqual([]);
    }
  });

  it('AC-PLAT-05 contains no fixture or seeded member data in the client bundle', () => {
    const seed = readFileSync(join(repoRoot, 'src/lib/server/db/seed-demo.ts'), 'utf8');
    const fixtures = walk(join(repoRoot, 'tests/fixtures'))
      .filter((file) => /\.(?:ts|mjs)$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    const seededEmails = exampleEmails(seed);
    const fixtureEmails = exampleEmails(fixtures);
    const seededNames = unique(
      [...seed.matchAll(/displayName:\s*'([^']+)'/g)].map((match) => match[1]!),
    ).filter((name) => name.length >= 5);

    // A scan over nothing would pass vacuously; the sources must yield needles.
    expect(seededEmails.length).toBeGreaterThanOrEqual(10);
    expect(fixtureEmails.length).toBeGreaterThanOrEqual(5);
    expect(seededNames.length).toBeGreaterThanOrEqual(5);

    const needles = unique([...seededEmails, ...fixtureEmails, ...seededNames]);
    const chunks = walk(clientDir)
      .filter((file) => /\.(?:js|css|html|json|svg|txt)$/.test(file))
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }));
    expect(chunks.length).toBeGreaterThan(20);

    const leaks = needles.flatMap((needle) =>
      chunks
        .filter((chunk) => chunk.text.includes(needle))
        .map((chunk) => `${needle} in ${relative(repoRoot, chunk.file)}`),
    );
    expect(leaks).toEqual([]);
  });

  it('AC-PLAT-05 is a production build: the dev identity provider is dropped', () => {
    // Present in a NODE_ENV=development build (server/chunks/context2.js), absent here.
    const marker = 'dev identity is only available to a loopback peer';
    const files = walk(join(repoRoot, '.svelte-kit/output')).filter((file) =>
      /\.(?:js|html|json)$/.test(file),
    );
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.includes('/output/server/'))).toBe(true);
    expect(files.some((file) => file.includes('/output/client/'))).toBe(true);
    const found = files.filter((file) => readFileSync(file, 'utf8').includes(marker));
    expect(found.map((file) => relative(repoRoot, file))).toEqual([]);
  });
});
