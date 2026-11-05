import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// AC-API-01: the route manifest is every route file under src/routes plus every
// row of the §11.2 table, so a route is swept before and after it is built.

export interface Route {
  method: string;
  path: string;
  upgrade?: boolean;
}

export function sample(path: string): string {
  return path.replace(/\[[^\]]+\]|:[a-z]+/gi, 'sample-id');
}

export function fileRoutes(dir = 'src/routes'): Route[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): Route[] => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return fileRoutes(full);
    const route =
      '/' +
      relative('src/routes', dir)
        .split(sep)
        .filter((part) => !/^\(.*\)$/.test(part))
        .join('/');
    const path = route === '/' ? '/' : route.replace(/\/$/, '');
    if (entry.name === '+page.svelte') return [{ method: 'GET', path }];
    // Form actions are POSTs to the page's own path (`?/name`).
    if (/^\+page\.server\.(ts|js)$/.test(entry.name)) {
      const source = readFileSync(full, 'utf8');
      return /export\s+const\s+actions\b/.test(source) ? [{ method: 'POST', path }] : [];
    }
    if (/^\+server\.(ts|js)$/.test(entry.name)) {
      const source = readFileSync(full, 'utf8');
      return [
        ...source.matchAll(
          /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
        ),
      ].map((match) => ({ method: match[1]!, path }));
    }
    return [];
  });
}

export function specRoutes(): Route[] {
  const spec = readFileSync('docs/spec/platform/11-api.md', 'utf8');
  const table = spec.slice(spec.indexOf('## 11.2 Routes'), spec.indexOf('## 11.3'));
  const routes: Route[] = [];
  for (const line of table.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || !cells[2]?.startsWith('`/')) continue;
    const paths = [...cells[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    for (const method of [...cells[1]!.matchAll(/`([A-Z]+)`( \(upgrade\))?/g)]) {
      for (const path of paths) routes.push({ method: method[1]!, path, upgrade: !!method[2] });
    }
  }
  return routes;
}

export const manifest = [...fileRoutes(), ...specRoutes()].map((route) => ({
  ...route,
  path: sample(route.path),
}));
export const key = (route: Route) => `${route.method} ${route.path}`;
export const unique = [...new Map(manifest.map((route) => [key(route), route])).values()];
