import { readFileSync } from 'node:fs';

const bundlePath = process.argv[2] ?? '.wrangler/dry-run/worker.js';

let source;
try {
  source = readFileSync(bundlePath, 'utf8');
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

if (!exportedNames(source).has('ChatRoom')) {
  console.error(`check-worker-exports: ${bundlePath} does not export ChatRoom`);
  process.exit(1);
}

// AC-PLAT-02/09: the Worker bundle must not carry the local adapters or the
// dev identity. `context.ts` imports them only in the dev/offline branch.
for (const token of [
  'better-sqlite3',
  'DevIdentityProvider',
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
