import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// The argument is the build output folder (or one file); every file in it is
// scanned, because the bundle may be split into chunks.
const bundlePath = process.argv[2] ?? '.wrangler/dry-run';

/** @param {string} path @returns {string[]} */
function filesUnder(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(join(path, entry.name)),
  );
}

let source;
let entrySource;
try {
  const files = filesUnder(bundlePath);
  if (files.length === 0) throw new Error('no files in the build output');
  // Source maps quote the sources they came from, so only code files count.
  const code = files.filter((file) => /\.m?js$/.test(file));
  if (code.length === 0) throw new Error('no .js or .mjs files in the build output');
  source = code.map((file) => readFileSync(file, 'utf8')).join('\n');
  // The Worker entry is worker.js; a single-file argument is its own entry.
  const entry = statSync(bundlePath).isDirectory()
    ? code.find((file) => basename(file) === 'worker.js')
    : bundlePath;
  entrySource = entry ? readFileSync(entry, 'utf8') : '';
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`check-worker-exports: cannot read ${bundlePath}: ${message}`);
  process.exit(1);
}

// AC-PLAT-04: the Worker build must export ChatRoom for the CHAT_ROOM binding.
// Parse export clauses by their exported names: `ChatRoom` and `X as ChatRoom`
// qualify, while `ChatRoom as Other` does not.
/** @param {string} bundle @returns {Set<string>} */
function exportedNames(bundle) {
  const names = new Set();
  for (const clause of bundle.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of (clause[1] ?? '').split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const name = (parts.length === 1 ? parts[0] : parts[1]) ?? '';
      const exported = name.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
    }
  }
  return names;
}

if (!exportedNames(entrySource).has('ChatRoom')) {
  console.error(`check-worker-exports: ${bundlePath} does not export ChatRoom`);
  process.exit(1);
}

// AC-PLAT-02/09: the Worker bundle must not carry the local adapters or the
// dev identity. `context.ts` imports them only in the dev/offline branch. The
// dev identity's error text is matched too: string literals survive minification.
for (const token of [
  'better-sqlite3',
  'DevIdentityProvider',
  'dev identity',
  'FsObjectStorage',
  'createLocalDatabase',
  'node:fs',
]) {
  if (source.includes(token)) {
    console.error(`check-worker-exports: ${bundlePath} contains ${token}`);
    process.exit(1);
  }
}

console.log(`check-worker-exports: ${bundlePath} exports ChatRoom`);
