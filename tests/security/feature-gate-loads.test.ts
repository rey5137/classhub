import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// R-NAV-02: SvelteKit skips a layout's load on a client navigation (`__data.json`), so
// every server load under a feature's folder checks the flag itself.
const FEATURES = ['discussions', 'memories', 'chat'];

function loads(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return loads(path);
    return /^\+(page|layout)\.server\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** The source with comments blanked, so a mention in a comment never counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The body of the exported `load` (up to its matching brace), or null when there is none. */
function loadBody(source: string): string | null {
  const code = stripComments(source);
  const start = /export\s+(const\s+load\b|async\s+function\s+load\b|function\s+load\b)/.exec(code);
  if (!start) return null;
  const from = start[1].startsWith('const')
    ? code.indexOf('=>', start.index)
    : code.slice(start.index).search(/\)\s*(:[^{]+)?\{/) + start.index;
  const open = from < start.index ? -1 : code.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  return null;
}

function gates(source: string, feature: string): boolean {
  const body = loadBody(source);
  return (
    body !== null &&
    new RegExp(`requireFeature\\(\\s*(locals|event\\.locals),\\s*'${feature}'`).test(body)
  );
}

describe('the static check itself', () => {
  const call = "requireFeature(locals, 'chat');";
  it('AC-NAV-04 accepts a call inside the load', () => {
    expect(gates(`export const load = async ({ locals }) => { ${call} return {}; };`, 'chat')).toBe(
      true,
    );
    expect(gates(`export async function load({ locals }) { ${call} }`, 'chat')).toBe(true);
  });
  it('AC-NAV-04 rejects a call only in an action or a comment', () => {
    const inAction = `export const load = async () => { return {}; };
export const actions = { save: async ({ locals }) => { ${call} } };`;
    const inComment = `export const load = async () => {
  // ${call}
  /* ${call} */
  return {};
};`;
    expect(gates(inAction, 'chat')).toBe(false);
    expect(gates(inComment, 'chat')).toBe(false);
    expect(gates(`export const actions = { a: () => { ${call} } };`, 'chat')).toBe(false);
  });
});

describe('feature gate on server loads', () => {
  it.each(FEATURES)(
    'AC-NAV-04 every %s page and layout load calls requireFeature in its load body',
    (feature) => {
      const files = loads(join('src/routes', feature));
      expect(files.length, `no server loads found under ${feature}`).toBeGreaterThan(0);
      const missing = files.filter((file) => {
        return !gates(readFileSync(file, 'utf8'), feature);
      });
      expect(missing, `found ${files.join(', ')}; missing requireFeature in`).toEqual([]);
    },
  );
});
