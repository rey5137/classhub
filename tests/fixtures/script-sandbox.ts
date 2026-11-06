import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startFakeApi, type FakeApi } from './fake-cloudflare-api';
import { fakeApi, fakeCli } from './fake-cloudflare.mjs';

// A copy of the repo's scripts in a temp dir, wired to the stateful fake CLI
// (fake-cloudflare.mjs) and the loopback fake API, so a script runs end to end
// through the real scripts/cf.mjs and never touches the real root or account.

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const ACCOUNT = '33333333333333333333333333333333';
export const TOKEN = 'sandbox-test-token';

/** What the scripts read at run time. */
const FILES = [
  'scripts/cf.mjs',
  'scripts/setup.mjs',
  'scripts/preflight.mjs',
  'scripts/unlock.mjs',
  'scripts/smoke-test.mjs',
  'scripts/deploy-check.mjs',
  'package.json',
  'scripts/lib',
  'wrangler.jsonc.example',
  'migrations',
  'site.config.ts',
  'src/lib/shared/normalize.ts',
  'src/lib/shared/seats.ts',
  'src/lib/themes/registry.ts',
  'src/lib/i18n/index.ts',
];

export interface FakeState {
  databases: { name: string; uuid: string }[];
  buckets: string[];
  secrets: Record<string, string>;
  worker: boolean;
  calls: string[][];
  subdomain?: string;
  devUrl?: Record<string, boolean>;
  customDomains?: Record<string, string[]>;
  /** `<command> <subcommand>` → the error the fake CLI fails with */
  failures?: Record<string, string>;
  /** `deployments list --json`, newest last or not: the gate takes the max. */
  deployments?: { id: string; created_on: string }[];
  /** When the first `secret put` uploaded the Worker; `deployments list` reports it. */
  workerCreatedAt?: string;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** The fake CLI calls this run made. */
  calls: string[][];
}

export interface Sandbox {
  dir: string;
  stateDir: string;
  api: FakeApi;
  readState(): FakeState;
  writeState(state: Partial<FakeState>): void;
  /** The SQLite file behind the (single) fake D1 database. */
  d1(): Database.Database;
  run(script: string, args?: string[], extraEnv?: Record<string, string>): Promise<RunResult>;
  /** The same fakes in process, as a `CfRunner` for unit tests (no cf.mjs, no subprocess). */
  runner(
    args: string[],
    options?: { input?: string },
  ): { status: number; stdout: string; stderr: string };
  close(): Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), 'classhub-scripts-'));
  const stateDir = join(dir, 'fake-state');
  mkdirSync(stateDir);
  for (const file of FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(dir, file), { recursive: true });
  }
  writeFileSync(
    join(dir, '.env.cloudflare'),
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\nACCESS_TEAM_DOMAIN=\nACCESS_AUD=\n`,
  );
  // cf.mjs runs CF_WRANGLER_BIN directly, so the fake gets a launcher.
  const bin = join(dir, 'fake-cli.sh');
  writeFileSync(
    bin,
    `#!/bin/sh\nexec "${process.execPath}" "${join(repoRoot, 'tests/fixtures/fake-cloudflare.mjs')}" "$@"\n`,
  );
  chmodSync(bin, 0o755);

  const statePath = join(stateDir, 'state.json');
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
  const writeState = (state: Partial<FakeState>) =>
    writeFileSync(
      statePath,
      JSON.stringify({
        databases: [],
        buckets: [],
        secrets: {},
        worker: false,
        calls: [],
        ...state,
      }),
    );
  writeState({ subdomain: 'fake-sub' });
  const api = await startFakeApi(stateDir, ACCOUNT, TOKEN);

  return {
    dir,
    stateDir,
    api,
    readState,
    writeState,
    d1() {
      const [database] = readState().databases;
      if (!database) throw new Error('the fake has no D1 database yet');
      const db = new Database(join(stateDir, `${database.uuid}.sqlite`));
      db.pragma('foreign_keys = ON');
      return db;
    },
    runner(args, options = {}) {
      if (args[0] === 'api') {
        // `api --put <path>` takes its body on stdin; the fake knows no policy, so both 404.
        const put = args[1] === '--put';
        const path = (put ? args[2] : args[1]) ?? '';
        const { status, body } = fakeApi(path, stateDir);
        return status === 200
          ? { status: 0, stdout: JSON.stringify(body.result), stderr: '' }
          : {
              status: 1,
              stdout: '',
              stderr: `cf.mjs: ${put ? 'PUT' : 'GET'} ${path} failed: HTTP ${status}`,
            };
      }
      return fakeCli(args, { stateDir, cwd: dir, account: ACCOUNT, input: options.input ?? '' });
    },
    // Async on purpose: the fake API answers from this process while the script runs.
    async run(script, args = [], extraEnv = {}) {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        CF_WRANGLER_BIN: bin,
        CF_API_BASE: api.base,
        FAKE_CF_STATE: stateDir,
        FAKE_CF_ACCOUNT: ACCOUNT,
        ...extraEnv,
      };
      const before = readState().calls.length;
      try {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          [join(dir, 'scripts', script), ...args],
          { env, encoding: 'utf8' },
        );
        return { status: 0, stdout, stderr, calls: readState().calls.slice(before) };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return {
          status: typeof failed.code === 'number' ? failed.code : 1,
          stdout: failed.stdout ?? '',
          stderr: failed.stderr ?? String(error),
          calls: readState().calls.slice(before),
        };
      }
    },
    async close() {
      await api.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
