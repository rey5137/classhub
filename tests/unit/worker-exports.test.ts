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

/** R-NTF-05: every passing bundle also carries the Web Push entrypoint. */
const PUSH_EXPORT = 'export { PushDelivery } from "./push-delivery.js";\n';

function run(bundle: string) {
  const file = join(dir, 'index.js');
  writeFileSync(file, bundle);
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
}

describe('scripts/check-worker-exports.mjs', () => {
  it('AC-PLAT-09 scans every file in the output folder, not only worker.js', () => {
    writeFileSync(join(dir, 'worker.js'), 'export { ChatRoom } from "./chunk.js";\n' + PUSH_EXPORT);
    writeFileSync(join(dir, 'chunk.js'), 'const adapter = FsObjectStorage;\n');

    const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FsObjectStorage');
  });

  it('AC-PLAT-04 looks for the ChatRoom export only in worker.js, not in a source map', () => {
    writeFileSync(join(dir, 'worker.js'), 'export default {};\n');
    writeFileSync(join(dir, 'worker.js.map'), '{"sourcesContent":["export { ChatRoom } from"]}');

    const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not export ChatRoom');
  });

  it('AC-PLAT-09 ignores forbidden tokens quoted in a source map', () => {
    writeFileSync(
      join(dir, 'worker.js'),
      'export { ChatRoom } from "./chat-room.js";\n' + PUSH_EXPORT,
    );
    writeFileSync(join(dir, 'worker.js.map'), '{"sourcesContent":["import \'node:fs\'"]}');

    const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

    expect(result.status).toBe(0);
  });

  it('AC-PLAT-04 accepts a bundle that exports ChatRoom', () => {
    const result = run('export { ChatRoom } from "./chat-room.js";\n' + PUSH_EXPORT);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exports ChatRoom');
  });

  it('AC-PLAT-04 accepts a renamed export that is exported as ChatRoom', () => {
    const result = run(
      'export { InternalChatRoom as ChatRoom } from "./chat-room.js";\n' + PUSH_EXPORT,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exports ChatRoom');
  });

  it('R-NTF-05 accepts a bundle that also exports PushDelivery, and fails without it', () => {
    const passing = run('export { ChatRoom } from "./chat-room.js";\n' + PUSH_EXPORT);
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('exports ChatRoom and PushDelivery');

    const missing = run('export { ChatRoom } from "./chat-room.js";\nclass PushDelivery {}\n');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('does not export PushDelivery');
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

  it('AC-PLAT-09 fails when the bundle contains the local database adapter', () => {
    const result = run(
      'export { ChatRoom } from "./chat-room.js";\n' + PUSH_EXPORT + 'import "better-sqlite3";\n',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('better-sqlite3');
  });

  it('AC-PLAT-09 fails when the bundle contains the dev identity identifier', () => {
    const result = run(
      'export { ChatRoom } from "./chat-room.js";\n' +
        PUSH_EXPORT +
        'const provider = DevIdentityProvider;\n',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DevIdentityProvider');
  });

  it('AC-PLAT-09 fails when a minified bundle keeps only the dev identity text', () => {
    const result = run(
      'export { ChatRoom } from "./chat-room.js";\n' +
        PUSH_EXPORT +
        'class a{x(){throw new E("dev identity refuses proxied requests")}}\n',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dev identity');
  });

  it('AC-PLAT-09 fails when the bundle contains the filesystem adapter identifier', () => {
    const result = run(
      'export { ChatRoom } from "./chat-room.js";\n' +
        PUSH_EXPORT +
        'const storage = FsObjectStorage;\n',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FsObjectStorage');
  });

  it('AC-PLAT-09 fails when the bundle contains the local database identifier', () => {
    const result = run(
      'export { ChatRoom } from "./chat-room.js";\n' +
        PUSH_EXPORT +
        'const open = createLocalDatabase;\n',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('createLocalDatabase');
  });

  it('AC-PLAT-09 fails when the bundle contains the local chat hub', () => {
    const result = run(
      'export { ChatRoom } from "./chat-room.js";\n' +
        PUSH_EXPORT +
        'const key = Symbol.for("classhub.chat.pendingUpgrades");\n',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('classhub.chat.pendingUpgrades');
  });
});
