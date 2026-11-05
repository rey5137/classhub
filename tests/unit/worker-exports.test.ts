import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'check-worker-exports.mjs');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'classhub-worker-exports-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(bundle: string) {
  const file = join(dir, 'index.js');
  writeFileSync(file, bundle);
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
}

describe('scripts/check-worker-exports.mjs', () => {
  it('AC-PLAT-04 accepts a bundle that exports ChatRoom', () => {
    const result = run('export { ChatRoom } from "./chat-room.js";\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exports ChatRoom');
  });

  it('AC-PLAT-04 accepts a renamed export that is exported as ChatRoom', () => {
    const result = run('export { InternalChatRoom as ChatRoom } from "./chat-room.js";\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exports ChatRoom');
  });

  it('AC-PLAT-04 fails when ChatRoom is exported under another name', () => {
    const result = run('export { ChatRoom as Other } from "./chat-room.js";\n');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not export ChatRoom');
  });

  it('AC-PLAT-04 fails when the bundle has no ChatRoom export', () => {
    const result = run('export default { fetch() { return new Response("ok"); } };\n');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not export ChatRoom');
  });

  it('AC-PLAT-04 fails when ChatRoom is defined but not exported', () => {
    const result = run('class ChatRoom {}\nexport default {};\n');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not export ChatRoom');
  });

  it('fails when the bundle is missing', () => {
    const result = spawnSync(process.execPath, [script, join(dir, 'missing.js')], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot read');
  });
});
