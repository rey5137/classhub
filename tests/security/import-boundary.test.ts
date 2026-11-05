import { ESLint } from 'eslint';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function ruleIds(filePath: string, source: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(source, { filePath: join(repoRoot, filePath) });
  return (result?.messages ?? []).map((message) => message.ruleId);
}

describe('AC-PLAT-02 import boundary', () => {
  it('AC-PLAT-02 fails a service importing a Cloudflare adapter', async () => {
    const rules = await ruleIds(
      'src/lib/server/services/fixture-imports-adapter.ts',
      "import { createD1Database } from '../../adapters/cloudflare/d1-database';\nexport const factory = createD1Database;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('AC-PLAT-02 fails a service importing a database driver', async () => {
    const rules = await ruleIds(
      'src/lib/server/services/fixture-imports-driver.ts',
      "import Database from 'better-sqlite3';\nexport const Client = Database;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('AC-PLAT-02 fails a service naming a Cloudflare type', async () => {
    const rules = await ruleIds(
      'src/lib/server/services/fixture-uses-type.ts',
      'export type Binding = D1Database;\n',
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('AC-PLAT-02 fails a service implementing a Cloudflare type', async () => {
    const rules = await ruleIds(
      'src/lib/server/services/fixture-implements.ts',
      'export class Fixture implements D1Database {}\n',
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('AC-PLAT-02 fails an app file importing Cloudflare types', async () => {
    const rules = await ruleIds(
      'src/lib/server/database-binding.ts',
      "import type { D1Database } from '@cloudflare/workers-types';\nexport type Binding = D1Database;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('AC-PLAT-02 allows the Cloudflare adapter to name D1 and R2 types', async () => {
    const rules = await ruleIds(
      'src/lib/server/adapters/cloudflare/fixture-binding.ts',
      "import type { D1Database } from '@cloudflare/workers-types';\nexport type Binding = D1Database;\n",
    );
    expect(rules).toEqual([]);
  });

  it('AC-PLAT-02 allows src/worker.ts to name a Cloudflare type', async () => {
    const rules = await ruleIds(
      'src/worker.ts',
      "import type { R2Bucket } from '@cloudflare/workers-types';\nexport type Bucket = R2Bucket;\n",
    );
    expect(rules).toEqual([]);
  });

  it('AC-PLAT-02 allows a service that imports only a port', async () => {
    const rules = await ruleIds(
      'src/lib/server/services/fixture-imports-port.ts',
      "import type { Database } from '../ports/database';\nexport type Store = Database;\n",
    );
    expect(rules).toEqual([]);
  });
});
