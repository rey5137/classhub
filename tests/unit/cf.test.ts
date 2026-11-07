import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteDatabase } from '../../src/lib/server/adapters/cloudflare/remote-database';
import {
  chatOverRetention,
  exportCandidates,
  pruneArchived,
  rangeRecords,
  recordVerifiedArchive,
} from '../../src/lib/server/repositories/chat-archive';
import { retainedObjectKeys } from '../../src/lib/server/repositories/housekeeping';
import {
  RESTORE_ACCESS_SUB_LEFT,
  RESTORE_CHAT_INSERT,
  RESTORE_CLEAR_ACCESS_SUB,
  RESTORE_CLEAR_PUSH_SUBSCRIPTIONS,
  RESTORE_FOREIGN_KEY_CHECK,
  RESTORE_LOCK_SETUP,
  RESTORE_MEDIA_SELECT,
  RESTORE_SETUP_STATE_SELECT,
  RESTORE_TARGET_TABLES,
  restoreCountSelect,
} from '../../scripts/lib/backup-sql.mjs';
import { chatInsert } from '../../scripts/lib/restore-chat.mjs';
import { createHousekeepingWrites } from '../../scripts/lib/housekeeping-writes.mjs';
import { startFakeApi, type FakeApi } from '../fixtures/fake-cloudflare-api';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const account = '11111111111111111111111111111111';
const otherAccount = '22222222222222222222222222222222';
const token = 'fake-token-for-tests';

interface Invocation {
  args: string[];
  hasAccountId: boolean;
  hasToken: boolean;
  accountId: string | null;
  token: string | null;
  cloudflareEnv: string[];
  home: string | null;
  xdgConfigHome: string | null;
}

let dir: string;
let cfScript: string;
let fakeWrangler: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'classhub-cf-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cfScript = join(dir, 'scripts', 'cf.mjs');
  fakeWrangler = join(dir, 'fake-wrangler.mjs');
  logPath = join(dir, 'wrangler.log');

  copyFileSync(join(repoRoot, 'scripts', 'cf.mjs'), cfScript);
  // cf.mjs imports the INV-7 gate and the pinned backup statements.
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const file of ['backup-gate', 'backup-sql', 'cf-child', 'migrations'])
    copyFileSync(
      join(repoRoot, 'scripts', 'lib', `${file}.mjs`),
      join(dir, 'scripts', 'lib', `${file}.mjs`),
    );
  copyFileSync(join(repoRoot, 'wrangler.jsonc.example'), join(dir, 'wrangler.jsonc.example'));
  copyFileSync(join(repoRoot, 'tests', 'fixtures', 'fake-wrangler.mjs'), fakeWrangler);
  chmodSync(fakeWrangler, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEnv(contents: string) {
  writeFileSync(join(dir, '.env.cloudflare'), contents);
}

function writeValidEnv() {
  writeEnv(`CLOUDFLARE_ACCOUNT_ID=${account}\nCLOUDFLARE_API_TOKEN=${token}\n`);
}

function writeWranglerConfig(accountId: string) {
  writeWranglerConfigSource(`{\n  "name": "classhub",\n  "account_id": "${accountId}"\n}\n`);
}

function writeWranglerConfigSource(source: string) {
  writeFileSync(join(dir, 'wrangler.jsonc'), source);
}

function run(args: string[], options: { whoami?: string; extraEnv?: Record<string, string> } = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CF_WRANGLER_BIN: fakeWrangler,
    FAKE_WRANGLER_LOG: logPath,
    FAKE_WRANGLER_WHOAMI: options.whoami ?? '',
    ...options.extraEnv,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLOUDFLARE_')) delete env[key];
  }
  delete env.FAKE_WRANGLER_EXIT;
  delete env.FAKE_WRANGLER_WHOAMI_EXIT;
  Object.assign(env, options.extraEnv ?? {});

  const result = spawnSync(process.execPath, [cfScript, ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });

  const invocations: Invocation[] = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Invocation)
    : [];

  return { result, invocations };
}

function whoami(accountId: string) {
  return JSON.stringify({
    loggedIn: true,
    accounts: [{ id: accountId, name: 'Test Account' }],
  });
}

function parseJsonc(source: string): Record<string, unknown> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return JSON.parse(withoutComments.replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>;
}

describe('scripts/cf.mjs', () => {
  it('AC-PLAT-06 refuses without .env.cloudflare', () => {
    const { result, invocations } = run(['whoami'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.env.cloudflare');
    expect(invocations).toHaveLength(0);
  });

  it('AC-PLAT-06 refuses without CLOUDFLARE_ACCOUNT_ID', () => {
    writeEnv(`CLOUDFLARE_API_TOKEN=${token}\n`);

    const { result, invocations } = run(['whoami'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(invocations).toHaveLength(0);
  });

  it('refuses a malformed CLOUDFLARE_ACCOUNT_ID before running wrangler', () => {
    writeEnv(`CLOUDFLARE_ACCOUNT_ID=not-an-account\nCLOUDFLARE_API_TOKEN=${token}\n`);

    const { result, invocations } = run(['whoami'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('32-character lowercase hexadecimal');
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(invocations).toHaveLength(0);
  });

  it('AC-PLAT-06 refuses when the token cannot see the account', () => {
    writeValidEnv();

    const { result, invocations } = run(['whoami'], { whoami: whoami(otherAccount) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot see account');
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual(['whoami', '--json']);
  });

  it('fails when whoami exits nonzero', () => {
    writeValidEnv();

    const { result, invocations } = run(['whoami'], {
      whoami: whoami(account),
      extraEnv: { FAKE_WRANGLER_WHOAMI_EXIT: '7' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('whoami failed');
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.token).toBe(token);
  });

  it('does not accept an account id that is only a substring of another id', () => {
    writeValidEnv();

    const { result } = run(['whoami'], { whoami: whoami(`${account}0`) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot see account');
  });

  it('runs the requested command with the guarded account and never prints the token', () => {
    writeValidEnv();

    const { result, invocations } = run(['whoami'], {
      whoami: whoami(account),
      extraEnv: { CLOUDFLARE_API_KEY: 'inherited-key', CLOUDFLARE_EMAIL: 'a@example.test' },
    });

    expect(result.status).toBe(0);
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toMatchObject({
      args: ['whoami'],
      hasAccountId: true,
      hasToken: true,
      accountId: account,
      token,
    });
    expect(invocations[1]?.cloudflareEnv.sort()).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  });

  it('propagates the wrangler exit code', () => {
    writeValidEnv();
    writeWranglerConfig(account);

    const { result } = run(['deploy'], {
      whoami: whoami(account),
      extraEnv: { FAKE_WRANGLER_EXIT: '7' },
    });

    expect(result.status).toBe(7);
  });

  it('AC-OPS-03 deploy refuses when wrangler.jsonc names another account', () => {
    writeValidEnv();
    writeWranglerConfig(otherAccount);

    const { result, invocations } = run(['deploy'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match');
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual(['whoami', '--json']);
  });

  it('AC-OPS-03 deploy accepts a matching wrangler.jsonc', () => {
    writeValidEnv();
    writeWranglerConfig(account);

    const { result, invocations } = run(['deploy'], { whoami: whoami(account) });

    expect(result.status).toBe(0);
    expect(invocations[1]).toMatchObject({
      args: ['deploy'],
      hasAccountId: true,
      hasToken: true,
    });
  });

  it('deploy refuses a missing wrangler.jsonc', () => {
    writeValidEnv();

    const { result } = run(['deploy'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('wrangler.jsonc is missing');
  });

  it('deploy refuses a wrangler.jsonc without account_id', () => {
    writeValidEnv();
    writeWranglerConfigSource('{\n  "name": "classhub"\n}\n');

    const { result } = run(['deploy'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('has no account_id');
  });

  it('ignores a commented-out account_id above the real one', () => {
    writeValidEnv();
    writeWranglerConfigSource(`{
  // "account_id": "${otherAccount}",
  /* "account_id": "${otherAccount}", */
  "name": "classhub",
  "account_id": "${account}",
}
`);

    const { result, invocations } = run(['deploy'], { whoami: whoami(account) });

    expect(result.status).toBe(0);
    expect(invocations[1]?.args).toEqual(['deploy']);
  });

  it('refuses when an env block names another account', () => {
    writeValidEnv();
    writeWranglerConfigSource(`{
  "name": "classhub",
  "account_id": "${account}",
  "env": { "staging": { "account_id": "${otherAccount}" } }
}
`);

    const { result } = run(['deploy'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('env.*.account_id');
  });

  it('AC-PLAT-06 d1 migrations apply --remote refuses a mismatched wrangler.jsonc', () => {
    writeValidEnv();
    writeWranglerConfig(otherAccount);

    const { result, invocations } = run(['d1', 'migrations', 'apply', 'DB', '--remote'], {
      whoami: whoami(account),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match');
    expect(invocations.map((entry) => entry.args[0])).toEqual(['whoami']);
  });

  it('AC-PLAT-06 legitimate remote commands are not mistaken for target flags', () => {
    writeValidEnv();
    writeWranglerConfig(account);

    for (const command of [
      ['d1', 'migrations', 'apply', 'DB', '--remote'],
      ['r2', 'bucket', 'create', 'x'],
    ]) {
      rmSync(logPath, { force: true });
      const { result, invocations } = run(command, { whoami: whoami(account) });
      expect(result.status, command.join(' ')).toBe(0);
      expect(invocations.map((entry) => entry.args[0])).toEqual(['whoami', command[0]]);
    }
  });

  it('R-BAK-03 d1 export reaches wrangler only as one whole export of the DB binding', () => {
    writeValidEnv();
    writeWranglerConfig(account);
    const allowed = run(['d1', 'export', 'DB', '--remote', '--output', join(dir, 'dump.sql')], {
      whoami: whoami(account),
    });
    expect(allowed.result.status).toBe(0);
    expect(allowed.invocations.map((entry) => entry.args.slice(0, 3))).toEqual([
      ['whoami', '--json'],
      ['d1', 'export', 'DB'],
    ]);
    const out = join(dir, 'dump.sql');
    for (const argv of [
      ['d1', 'export', 'other-db', '--remote', '--output', out],
      ['d1', 'export', '--remote', 'DB', '--output', out],
      ['d1', 'export', 'DB', '--output', out],
      ['d1', 'export', 'DB', '--remote', '--output', out, '--table', 'users'],
      ['d1', 'export', 'DB', '--remote', '--output', out, '--no-data'],
      ['d1', 'export', 'DB', '--remote', '--output', '--no-schema'],
      ['d1', 'export', 'DB', '--remote', `--output=${out}`],
    ]) {
      rmSync(logPath, { force: true });
      const refused = run(argv, { whoami: whoami(account) });
      expect(refused.result.status, argv.join(' ')).not.toBe(0);
      expect(refused.result.stderr).toContain('d1 export may only run as');
      expect(refused.invocations.map((entry) => entry.args[0])).toEqual(['whoami']);
    }
  });

  it('AC-PLAT-06 a non-deploy command is refused when only env.x.account_id names another account', () => {
    writeValidEnv();
    writeWranglerConfigSource(
      `{\n  "name": "classhub",\n  "env": { "x": { "account_id": "${otherAccount}" } }\n}\n`,
    );

    const { result, invocations } = run(['d1', 'list'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs');
    expect(invocations.map((entry) => entry.args[0])).toEqual(['whoami']);
  });

  it('AC-PLAT-06 a non-deploy command runs when only env.x.account_id matches the account', () => {
    writeValidEnv();
    writeWranglerConfigSource(
      `{\n  "name": "classhub",\n  "env": { "x": { "account_id": "${account}" } }\n}\n`,
    );

    const { result } = run(['d1', 'list'], { whoami: whoami(account) });

    expect(result.status).toBe(0);
  });

  it('AC-PLAT-06 a non-deploy command runs with a matching wrangler.jsonc', () => {
    writeValidEnv();
    writeWranglerConfig(account);

    const { result, invocations } = run(['d1', 'list'], { whoami: whoami(account) });

    expect(result.status).toBe(0);
    expect(invocations.map((entry) => entry.args[0])).toEqual(['whoami', 'd1']);
  });

  it('AC-PLAT-06 a non-deploy command runs when wrangler.jsonc has no account_id', () => {
    writeValidEnv();
    writeWranglerConfigSource('{\n  "name": "classhub"\n}\n');

    const { result } = run(['d1', 'list'], { whoami: whoami(account) });

    expect(result.status).toBe(0);
  });

  it('AC-PLAT-06 an unparseable wrangler.jsonc says so and stops a non-deploy command', () => {
    writeValidEnv();
    writeWranglerConfigSource('{ "account_id": ');

    const { result, invocations } = run(['d1', 'list'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not be parsed');
    expect(result.stderr).not.toContain('missing');
    expect(invocations.map((entry) => entry.args[0])).toEqual(['whoami']);
  });

  it('AC-PLAT-06 refuses a token that sees more than one account', () => {
    writeValidEnv();
    writeWranglerConfig(account);
    const many = JSON.stringify({
      loggedIn: true,
      accounts: [{ id: account }, { id: otherAccount }],
    });

    for (const command of [['d1', 'list'], ['deploy'], ['--check-deploy']]) {
      const { result, invocations } = run(command, { whoami: many });
      expect(result.status, command.join(' ')).not.toBe(0);
      expect(result.stderr).toContain('more than one account');
      expect(invocations.map((entry) => entry.args[0])).toEqual(['whoami']);
      rmSync(logPath, { force: true });
    }
  });

  it('AC-PLAT-06 refuses --cwd, --env-file and the attached -cX / -eX forms', () => {
    writeValidEnv();
    writeWranglerConfig(account);
    // node itself reads --env-file anywhere in argv, so the file must exist.
    writeFileSync(join(dir, '.env.other'), '');

    for (const flag of [
      ['--cwd', 'other'],
      ['--cwd=other'],
      ['--env-file', '.env.other'],
      ['--env-file=.env.other'],
      ['-cother.jsonc'],
      ['-estaging'],
      ['--e', 'staging'],
      ['--c=x.jsonc'],
      ['--envFile=.env.other'],
      ['-vc', 'x.jsonc'],
    ]) {
      const { result, invocations } = run(['d1', 'list', ...flag], { whoami: whoami(account) });
      expect(result.status, flag.join(' ')).not.toBe(0);
      expect(result.stderr).toContain('is not allowed');
      expect(invocations, flag.join(' ')).toHaveLength(0);
    }
  });

  it('AC-PLAT-06 a local dry-run needs no account check even with a mismatched wrangler.jsonc', () => {
    writeWranglerConfig(otherAccount);

    const { result, invocations } = run(['deploy', '--dry-run', '--outdir', 'out']);

    expect(result.status).toBe(0);
    expect(invocations.map((entry) => entry.args[0])).toEqual(['deploy']);
  });

  it('refuses --config, -c, --env and -e outside a local dry-run', () => {
    writeValidEnv();
    writeWranglerConfig(account);

    for (const flag of [
      ['--config', 'other.jsonc'],
      ['--config=other.jsonc'],
      ['-c', 'other.jsonc'],
      ['--env=staging'],
      ['-e', 'staging'],
    ]) {
      const { result, invocations } = run(['deploy', ...flag], { whoami: whoami(account) });
      expect(result.status, flag.join(' ')).not.toBe(0);
      expect(result.stderr).toContain(flag[0].split('=')[0]);
      expect(invocations, flag.join(' ')).toHaveLength(0);
    }
  });

  it('deploy --dry-run runs without .env.cloudflare and renders the example config', () => {
    const { result, invocations } = run(['deploy', '--dry-run', '--outdir', '.wrangler/dry-run']);

    expect(result.status).toBe(0);
    expect(invocations).toHaveLength(1);
    const deployArgs = invocations[0]?.args ?? [];
    expect(invocations[0]?.hasAccountId).toBe(false);
    expect(invocations[0]?.hasToken).toBe(false);
    expect(invocations[0]?.cloudflareEnv).toEqual([]);
    const realDir = realpathSync(dir);
    expect(invocations[0]?.home).toBe(join(realDir, '.wrangler', 'cf-home', 'home'));
    expect(invocations[0]?.xdgConfigHome).toBe(join(realDir, '.wrangler', 'cf-home', 'config'));
    const outdirIndex = deployArgs.indexOf('--outdir');
    expect(isAbsolute(deployArgs[outdirIndex + 1] ?? '')).toBe(true);

    const configIndex = deployArgs.indexOf('--config');
    expect(configIndex).toBeGreaterThan(-1);
    const configPath = deployArgs[configIndex + 1] ?? '';
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      account_id: string;
      main: string;
      workers_dev: boolean;
      preview_urls: boolean;
      migrations: { new_sqlite_classes?: string[] }[];
    };

    expect(config.account_id).toBe('00000000000000000000000000000000');
    expect(config.main).toBe(join(realDir, 'src', 'worker.ts'));
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.migrations[0]?.new_sqlite_classes).toContain('ChatRoom');
  });

  it('accepts the --outdir=<path> dry-run form', () => {
    const { result, invocations } = run(['deploy', '--dry-run', '--outdir=.wrangler/dry-run']);

    expect(result.status).toBe(0);
    expect(invocations).toHaveLength(1);
    const deployArgs = invocations[0]?.args ?? [];
    const outdir = deployArgs.find((arg) => arg.startsWith('--outdir='));
    expect(isAbsolute(outdir?.slice('--outdir='.length) ?? '')).toBe(true);
  });

  it.each([
    ['deploy', '--dry-run', '--no-dry-run'],
    ['deploy', '--dry-run', '--dry-run'],
    ['deploy', '--dry-run=false'],
    ['deploy', '--dry-run', '--outdir'],
    ['deploy', '--dry-run', '--outdir', '.wrangler/dry-run', 'extra'],
    ['whoami', '--dry-run'],
  ])('does not exempt the bypass form %j from the full guard', (...argv) => {
    const { result, invocations } = run(argv);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.env.cloudflare');
    expect(invocations).toHaveLength(0);
  });

  it('does not exempt a dry-run that carries a disallowed flag', () => {
    const { result, invocations } = run([
      'deploy',
      '--dry-run',
      '--outdir',
      '.wrangler/dry-run',
      '--config',
      'other.jsonc',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--config');
    expect(invocations).toHaveLength(0);
  });

  it('strips inherited CLOUDFLARE_* variables in a dry-run', () => {
    const { result, invocations } = run(['deploy', '--dry-run', '--outdir', '.wrangler/dry-run'], {
      extraEnv: {
        CLOUDFLARE_ACCOUNT_ID: otherAccount,
        CLOUDFLARE_API_TOKEN: 'inherited-token',
        CLOUDFLARE_API_KEY: 'inherited-key',
        CLOUDFLARE_EMAIL: 'a@example.test',
      },
    });

    expect(result.status).toBe(0);
    expect(invocations[0]?.cloudflareEnv).toEqual([]);
    expect(invocations[0]?.token).toBeNull();
    expect(invocations[0]?.accountId).toBeNull();
  });

  it('--check-deploy runs the deploy guard and stops before wrangler deploy', () => {
    writeValidEnv();
    writeWranglerConfig(account);

    const { result, invocations } = run(['--check-deploy'], { whoami: whoami(account) });

    expect(result.status).toBe(0);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual(['whoami', '--json']);
  });

  it('--check-deploy refuses a mismatched account', () => {
    writeValidEnv();
    writeWranglerConfig(otherAccount);

    const { result, invocations } = run(['--check-deploy'], { whoami: whoami(account) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match');
    expect(invocations).toHaveLength(1);
  });

  it('runs the deploy guard before building and deploying', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const deploy = packageJson.scripts?.deploy ?? '';

    const steps = deploy.split('&&').map((step) => step.trim());

    expect(steps).toEqual([
      'node scripts/cf.mjs --check-deploy',
      // R-OPS-08 / R-AUTH-05: the schema guard and the Access vars, after the account guard.
      'node scripts/deploy-check.mjs',
      'npm run build',
      'npm run build:worker-check',
      'node scripts/cf.mjs deploy',
    ]);
  });

  it('keeps wrangler.build.jsonc and wrangler.jsonc.example in agreement', () => {
    const build = parseJsonc(readFileSync(join(repoRoot, 'wrangler.build.jsonc'), 'utf8'));
    const example = parseJsonc(readFileSync(join(repoRoot, 'wrangler.jsonc.example'), 'utf8'));

    for (const key of [
      'assets',
      'compatibility_date',
      'compatibility_flags',
      'durable_objects',
      'migrations',
    ]) {
      expect(build[key], key).toEqual(example[key]);
    }
  });
});

describe('scripts/cf.mjs api (read-only Cloudflare API GET)', () => {
  let api: FakeApi;

  beforeEach(async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ buckets: ['b1'], subdomain: 'sub' }));
    api = await startFakeApi(dir, account, token);
  });

  afterEach(() => api.close());

  // Async: the fake API answers from this process while cf.mjs runs.
  async function runApi(
    args: string[],
    options: { base?: string; config?: string; input?: string } = {},
  ) {
    if (options.config) writeWranglerConfigSource(options.config);
    try {
      const pending = promisify(execFile)(process.execPath, [cfScript, ...args], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? '',
          CF_WRANGLER_BIN: fakeWrangler,
          FAKE_WRANGLER_LOG: logPath,
          FAKE_WRANGLER_WHOAMI: whoami(account),
          CF_API_BASE: options.base ?? api.base,
        },
        encoding: 'utf8',
      });
      pending.child.stdin?.end(options.input ?? '');
      const { stdout } = await pending;
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  }

  const databaseId = '11111111-1111-4111-8111-111111111111';
  const d1Config = () =>
    JSON.stringify({
      account_id: account,
      d1_databases: [{ binding: 'DB', database_id: databaseId }],
    });

  it('AC-MEM-09 sends a single D1 raw statement on stdin through the binding and account guards', async () => {
    writeValidEnv();
    const input = JSON.stringify({
      sql: 'UPDATE storage_usage SET committed_bytes = ?',
      params: [42],
    });
    const result = await runApi(['d1-query', databaseId], { input, config: d1Config() });
    expect(result.status).toBe(0);
    expect(api.bodies).toEqual([input]);
    expect(api.requests).toEqual([
      `POST /client/v4/accounts/${account}/d1/database/${databaseId}/raw token`,
    ]);
    expect(result.stdout + result.stderr).not.toContain(token);
    const mismatch = await runApi(['d1-query', databaseId], {
      input,
      config: JSON.stringify({ account_id: 'b'.repeat(32) }),
    });
    expect(mismatch.status).not.toBe(0);
    expect(api.requests).toHaveLength(1);
  });

  it.each([
    'SELECT "upload_reservations"."id" FROM "upload_reservations" WHERE "upload_reservations"."state" = ? ORDER BY "upload_reservations"."id" LIMIT ?',
    "UPDATE storage_usage SET reserved_bytes = (SELECT coalesce(sum(reserved_bytes), 0) FROM upload_reservations WHERE state = 'open') WHERE singleton_id = ?",
    'DELETE FROM media WHERE media.id = ?',
    'INSERT INTO schema_meta (key, value) VALUES (?, ?)',
    'INSERT INTO backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) VALUES (?, ?, ?, ?, ?, ?)',
  ])('AC-MEM-09 allows parameterized maintenance SQL: %s', async (sql) => {
    writeValidEnv();
    expect(
      (
        await runApi(['d1-query', databaseId], {
          config: d1Config(),
          input: JSON.stringify({ sql, params: [1, 2] }),
        })
      ).status,
    ).toBe(0);
  });

  it('AC-MEM-09 allows every statement the reconcile and REST purge actually send', async () => {
    writeValidEnv();
    const sent: { sql: string; params: unknown[] }[] = [];
    // `returning` reads rows back, so the fake answers with one row of zeros.
    const remote = createRemoteDatabase(async (statement) => {
      sent.push(statement);
      return [
        {
          success: true,
          results: { columns: ['a', 'b'], rows: [[0, 0]] },
          meta: { changes: 1 },
        },
      ];
    });
    const writes = createHousekeepingWrites(remote);
    await retainedObjectKeys(
      remote,
      ['media/v1/a/image.webp', 'avatars/v1/o/b.webp', 'staging/v1/c/image.webp'],
      1,
    );
    await writes.markPurged(remote, ['a'], 1, 1);
    await writes.releaseExpired(remote, ['a'], 1);
    expect(sent.some((statement) => /returning/i.test(statement.sql))).toBe(true);
    expect(sent.some((statement) => /max\(0,/i.test(statement.sql))).toBe(true);
    expect(sent.some((statement) => /case when/i.test(statement.sql))).toBe(true);
    expect(sent.some((statement) => /"media"."id" in/i.test(statement.sql))).toBe(true);
    for (const statement of sent) {
      const result = await runApi(['d1-query', databaseId], {
        config: d1Config(),
        input: JSON.stringify(statement),
      });
      expect(result.status, statement.sql).toBe(0);
    }
  });

  it('R-CHAT-14 allows every statement export-chat and prune-chat send, and nothing on users', async () => {
    writeValidEnv();
    const sent: { sql: string; params: unknown[] }[] = [];
    // Answers by statement shape so each code path runs once: an archive, a candidate, no deletes.
    const remote = createRemoteDatabase(async (statement) => {
      sent.push(statement);
      const sql = statement.sql.toLowerCase();
      const rows = sql.startsWith('delete')
        ? []
        : sql.includes('count(')
          ? [[0]]
          : sql.includes('from "chat_archives"')
            ? [[2, 'm2', 'm1', 'm2', 1, 2, 0]]
            : sql.includes('"client_nonce"')
              ? [['m3', 'main', 'u1', 'n3', 'body', 3, null, null]]
              : [[3, 'm3']];
      return [{ success: true, results: { columns: [], rows }, meta: { changes: 0 } }];
    });
    const policy = { retainDays: 1, maxMessages: 1 };
    const [range] = await exportCandidates(remote, policy, 10 * 86_400_000);
    await rangeRecords(remote, range!.from, range!.to);
    await recordVerifiedArchive(remote, {
      range: range!,
      sha256: 'a',
      exportedAt: 1,
      verifiedAt: 1,
    });
    await chatOverRetention(remote, policy, 1);
    await pruneArchived(remote, { now: () => 1, pause: async () => {} });
    for (const pattern of [
      /^select/i,
      /^insert into "chat_archives"/i,
      /^delete from "chat_messages"/i,
      /^update "chat_archives"/i,
    ])
      expect(
        sent.some((statement) => pattern.test(statement.sql)),
        String(pattern),
      ).toBe(true);
    for (const statement of sent) {
      const result = await runApi(['d1-query', databaseId], {
        config: d1Config(),
        input: JSON.stringify(statement),
      });
      expect(result.status, statement.sql).toBe(0);
    }
  });

  it.each([
    'SELECT body FROM chat_messages JOIN users ON users.id = chat_messages.sender_id',
    'DELETE FROM chat_messages WHERE sender_id IN (SELECT id FROM users)',
    'INSERT INTO chat_archives (id) SELECT id FROM profile_contacts',
  ])('R-CHAT-14 chat statements still refuse other tables: %s', async (sql) => {
    writeValidEnv();
    const result = await runApi(['d1-query', databaseId], {
      config: d1Config(),
      input: JSON.stringify({ sql, params: [] }),
    });
    expect(result.status).not.toBe(0);
    expect(api.requests).toEqual([]);
  });

  it("R-CHAT-15 passes restore --chat's pinned insert as rendered, and no variant of it", async () => {
    writeValidEnv();
    const sent: { sql: string; params: unknown[] }[] = [];
    const remote = createRemoteDatabase(async (statement) => {
      sent.push(statement);
      return [{ success: true, results: { columns: [], rows: [] }, meta: { changes: 0 } }];
    });
    await remote.db.all(
      chatInsert({
        id: 'm1',
        roomId: 'main',
        senderId: 'u1',
        clientNonce: 'n1',
        body: 'hello',
        createdAt: 1,
        editedAt: null,
      } as Parameters<typeof chatInsert>[0]),
    );
    expect(sent.map((statement) => statement.sql)).toEqual([RESTORE_CHAT_INSERT]);
    const ok = await runApi(['d1-query', databaseId], {
      config: d1Config(),
      input: JSON.stringify(sent[0]),
    });
    expect(ok.status).toBe(0);
    for (const sql of [
      RESTORE_CHAT_INSERT.replace(
        'ON CONFLICT DO NOTHING',
        'ON CONFLICT (id) DO UPDATE SET body = ?',
      ),
      `${RESTORE_CHAT_INSERT} `,
      RESTORE_CHAT_INSERT.replace('FROM users', 'FROM users, profile_contacts'),
    ]) {
      const refused = await runApi(['d1-query', databaseId], {
        config: d1Config(),
        input: JSON.stringify({ sql, params: [] }),
      });
      expect(refused.status, sql).not.toBe(0);
    }
  });

  it.each([
    'DROP TABLE media',
    'ALTER TABLE media ADD value TEXT',
    'CREATE TABLE media (id TEXT)',
    'SELECT * FROM users',
    'UPDATE "users" SET name = ?',
    'DELETE FROM users',
    'SELECT * FROM media, users',
    "SELECT * FROM media JOIN 'users'",
    'SELECT * FROM media WHERE EXISTS (SELECT 1 FROM"users")',
    "SELECT * FROM media WHERE EXISTS (SELECT 1 FROM'users')",
    'SELECT * FROM media NOT INDEXED, users',
    'SELECT * FROM media m, users u',
    'SELECT * FROM media; DELETE FROM users',
    'SELECT * FROM media /* comment */',
    'SELECT * FROM main.media',
    'WITH x AS (SELECT * FROM users) SELECT * FROM x',
    // R-BAK-09: backup_runs takes one plain INSERT, nothing else.
    'SELECT * FROM backup_runs',
    'UPDATE backup_runs SET verified_at = ?',
    'DELETE FROM backup_runs',
    'INSERT INTO backup_runs (id) SELECT id FROM media',
    'INSERT INTO media (id) SELECT id FROM backup_runs',
    // INV-7: only the exact statement backup sends can mint a verified backup.
    'INSERT INTO backup_runs (id) VALUES (?)',
    'insert into backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) values (?, ?, ?, ?, ?, ?)',
    'INSERT INTO backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) VALUES (?, ?, ?, ?, ?, 1)',
    'INSERT INTO backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at)  VALUES (?, ?, ?, ?, ?, ?)',
    // The shared scanner: a quote inside a comment or identifier cannot hide what follows.
    "select 1 from media -- '\ndelete from media;\n-- '",
    'select "\'" from media /* \' */',
  ])('AC-MEM-09 refuses SQL outside the housekeeping subset: %s', async (sql) => {
    writeValidEnv();
    const result = await runApi(['d1-query', databaseId], {
      config: d1Config(),
      input: JSON.stringify({ sql, params: [] }),
    });
    expect(result.status).not.toBe(0);
    expect(api.requests).toEqual([]);
  });

  it('AC-MEM-09 refuses another database, generic POST and malformed input', async () => {
    writeValidEnv();
    for (const [args, input] of [
      [
        ['d1-query', '22222222-2222-4222-8222-222222222222'],
        '{"sql":"SELECT * FROM media","params":[]}',
      ],
      [['api', '--post', `/d1/database/${databaseId}/query`], '{}'],
      [['d1-query', databaseId], '{'],
      [['d1-query', databaseId], '[{"sql":"SELECT * FROM media","params":[]}]'],
      [['d1-query', databaseId], '{"sql":"SELECT * FROM media","params":[],"batch":[]}'],
    ] as const) {
      expect((await runApi([...args], { config: d1Config(), input })).status).not.toBe(0);
    }
    expect(api.requests).toEqual([]);
  });

  it('AC-MEM-09 the fake D1 API rejects unsupported body shapes on query and raw', async () => {
    for (const endpoint of ['query', 'raw']) {
      for (const body of [[], { batch: [] }, { sql: 'SELECT 1' }, { sql: 42, params: [] }]) {
        const response = await fetch(
          `${api.base}/client/v4/accounts/${account}/d1/database/${databaseId}/${endpoint}`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          },
        );
        expect(response.status).toBe(400);
      }
    }
  });

  it('AC-PLAT-07 GETs under the guarded account with the .env.cloudflare token in a header only', async () => {
    writeValidEnv();
    const result = await runApi(['api', '/r2/buckets/b1']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ name: 'b1' });
    expect(api.requests).toEqual([`GET /client/v4/accounts/${account}/r2/buckets/b1 token`]);
    expect(result.stdout).not.toContain(token);
    // whoami ran first; the token was never an argument.
    const calls = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(calls.map((line) => (JSON.parse(line) as Invocation).args[0])).toEqual(['whoami']);
  });

  it('AC-PLAT-06 api refuses a mismatched wrangler.jsonc before any request', async () => {
    writeValidEnv();
    const result = await runApi(['api', '/r2/buckets/b1'], {
      config: `{ "account_id": "${otherAccount}" }`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match');
    expect(api.requests).toEqual([]);
  });

  it.each(['http://example.test:80', 'https://127.0.0.1:1', 'http://localhost:1'])(
    'refuses CF_API_BASE %s, so the token cannot leave the machine',
    async (base) => {
      writeValidEnv();
      const result = await runApi(['api', '/r2/buckets/b1'], { base });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CF_API_BASE');
    },
  );

  // Only the three read shapes the scripts use; the paginated list is not one of them.
  it.each([
    '/r2/buckets',
    '/r2/buckets?per_page=100',
    '/r2/buckets/B1',
    '/r2/buckets/b1/objects',
    '/r2/buckets/b1/domains/other',
    '/workers/scripts',
    '/access/apps',
    'r2/buckets/b1',
    '/r2/../users',
    '/a b',
  ])('refuses the path %j', async (path) => {
    writeValidEnv();
    const result = await runApi(['api', path]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('usage');
    expect(api.requests).toEqual([]);
  });

  it('fails with the HTTP status and error codes, not a body', async () => {
    writeValidEnv();
    const result = await runApi(['api', '/r2/buckets/missing']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HTTP 404 (10006)');
    expect(result.stdout).toBe('');
  });

  // INV-9 / R-AUTH-18: the Access policy is read and written through the guarded `api`.
  const policyPath = '/access/apps/app-1/policies/pol-1';
  const policyBody = JSON.stringify({
    name: 'Class list',
    include: [{ email: { email: 'a@x.test' } }],
  });

  it('AC-AUTH-11 api --put writes the Access policy after the account guard, body from stdin', async () => {
    writeValidEnv();
    const result = await runApi(['api', '--put', policyPath], { input: policyBody });

    expect(result.status).toBe(0);
    expect(api.requests).toEqual([`PUT /client/v4/accounts/${account}${policyPath} token`]);
    expect(api.bodies).toEqual([policyBody]);
    const calls = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(calls.map((line) => (JSON.parse(line) as Invocation).args[0])).toEqual(['whoami']);
  });

  it('AC-AUTH-11 api reads the policy under both path shapes', async () => {
    writeValidEnv();
    for (const path of [policyPath, '/access/policies/pol-1']) {
      expect((await runApi(['api', path])).stderr).not.toContain('usage');
    }
  });

  it('AC-PLAT-06 api --put refuses a mismatched wrangler.jsonc before any request', async () => {
    writeValidEnv();
    const result = await runApi(['api', '--put', policyPath], {
      config: `{ "account_id": "${otherAccount}" }`,
      input: policyBody,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match');
    expect(api.requests).toEqual([]);
  });

  // PUT is for the policy path only; every other shape, including readable ones, is refused.
  it.each([
    '/r2/buckets/b1',
    '/r2/buckets/b1/domains/managed',
    '/workers/subdomain',
    '/access/apps',
    '/access/apps/app-1',
    '/access/apps/app-1/policies',
    '/access/policies/pol-1/extra',
    '/access/apps/a/b/policies/pol-1',
    '/access/policies/pol 1',
    'access/policies/pol-1',
  ])('AC-AUTH-11 api --put refuses the path %j', async (path) => {
    writeValidEnv();
    const result = await runApi(['api', '--put', path], { input: policyBody });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('usage');
    expect(api.requests).toEqual([]);
  });

  it('AC-AUTH-11 api --put refuses a body that is not JSON and an extra argument', async () => {
    writeValidEnv();
    const bad = await runApi(['api', '--put', policyPath], { input: 'not json' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('JSON');
    const extra = await runApi(['api', '--put', policyPath, 'x'], { input: policyBody });
    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toContain('usage');
    expect(api.requests).toEqual([]);
  });
});

describe('scripts/cf.mjs INV-7 gate and remote SQL shape (R-DB-11, R-OPS-12)', () => {
  const fake = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args }) + '\\n');
const rows = (results) => process.stdout.write(JSON.stringify([{ results }]));
if (args[0] === 'whoami') process.stdout.write(process.env.FAKE_WRANGLER_WHOAMI);
else if (args[0] === 'deployments') process.stdout.write('[]');
else if (args[0] === 'd1' && args[1] === 'execute') {
  const sql = args.at(-1);
  if (process.env.FAKE_D1_ERROR && sql.includes('d1_migrations')) {
    process.stderr.write(process.env.FAKE_D1_ERROR);
    process.exitCode = 1;
  } else if (sql.includes('d1_migrations')) rows(JSON.parse(process.env.FAKE_APPLIED ?? '[]').map((name) => ({ name })));
  else if (sql.includes('backup_runs')) rows([{ at: process.env.FAKE_BACKUP_AT ? Number(process.env.FAKE_BACKUP_AT) : null }]);
  else if (sql.includes('sqlite_master')) rows(JSON.parse(process.env.FAKE_RESTORE_TABLES ?? '[]'));
}
`;
  const apply = ['d1', 'migrations', 'apply', 'DB', '--remote'];

  beforeEach(() => {
    writeValidEnv();
    writeWranglerConfig(account);
    writeFileSync(join(dir, 'fake-gate-wrangler.mjs'), fake);
    chmodSync(join(dir, 'fake-gate-wrangler.mjs'), 0o755);
    mkdirSync(join(dir, 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'migrations', '0001_init.sql'), 'select 1;');
  });

  function gated(args: string[], extraEnv: Record<string, string> = {}) {
    return run(args, {
      whoami: whoami(account),
      extraEnv: { CF_WRANGLER_BIN: join(dir, 'fake-gate-wrangler.mjs'), ...extraEnv },
    });
  }
  const applied = (invocations: Invocation[]) =>
    invocations.some((entry) => entry.args.join(' ') === apply.join(' '));
  const destructive = () =>
    writeFileSync(join(dir, 'migrations', '0009_x_destructive.sql'), 'drop table x;');

  it('AC-OPS-06 refuses a pending destructive migration with no verified backup, without spawning the apply', () => {
    destructive();
    const { result, invocations } = gated(apply, { FAKE_APPLIED: '["0001_init.sql"]' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('0009_x_destructive.sql');
    expect(result.stderr).toContain('no verified backup exists');
    expect(applied(invocations)).toBe(false);
  });

  it('AC-OPS-06 applies a pending destructive migration once a backup newer than the last deploy exists', () => {
    destructive();
    const { result, invocations } = gated(apply, {
      FAKE_APPLIED: '["0001_init.sql"]',
      FAKE_BACKUP_AT: '1700000000000',
    });
    expect(result.status).toBe(0);
    expect(applied(invocations)).toBe(true);
  });

  it('AC-OPS-06 does not gate a destructive migration that is already applied, or a run with only additive files', () => {
    destructive();
    expect(
      applied(
        gated(apply, { FAKE_APPLIED: '["0001_init.sql","0009_x_destructive.sql"]' }).invocations,
      ),
    ).toBe(true);
    rmSync(join(dir, 'migrations', '0009_x_destructive.sql'));
    rmSync(logPath);
    const additive = gated(apply, { FAKE_D1_ERROR: 'would fail if read' });
    expect(additive.result.status).toBe(0);
    expect(
      additive.invocations.some((entry) => entry.args[0] === 'd1' && entry.args[1] === 'execute'),
    ).toBe(false);
  });

  it('AC-OPS-06 allows a database with no d1_migrations table yet, on that exact error only', () => {
    destructive();
    const fresh = gated(apply, {
      FAKE_D1_ERROR: 'D1_ERROR: no such table: d1_migrations: SQLITE_ERROR',
    });
    expect(fresh.result.status).toBe(0);
    expect(applied(fresh.invocations)).toBe(true);
  });

  it.each([
    'D1_ERROR: network unreachable',
    'D1_ERROR: no such table d1_migrations (reworded)',
    'D1_ERROR: no such table: users',
  ])('AC-OPS-06 fails closed on any other unreadable migration state: %s', (message) => {
    destructive();
    rmSync(logPath, { force: true });
    const { result, invocations } = gated(apply, { FAKE_D1_ERROR: message });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot read the applied migrations');
    expect(applied(invocations)).toBe(false);
  });

  it.each([
    ['--file', ['d1', 'execute', 'DB', '--remote', '--file', 'x.sql']],
    [
      'an extra flag',
      ['d1', 'execute', 'DB', '--remote', '--json', '--command', 'select 1', '--yes'],
    ],
    ['a missing --json', ['d1', 'execute', 'DB', '--remote', '--command', 'select 1']],
    ['another database', ['d1', 'execute', 'OTHER', '--remote', '--json', '--command', 'select 1']],
    ['DROP', ['d1', 'execute', 'DB', '--remote', '--json', '--command', 'drop table users']],
    [
      'ALTER',
      ['d1', 'execute', 'DB', '--remote', '--json', '--command', 'ALTER TABLE users ADD x'],
    ],
    ['CREATE', ['d1', 'execute', 'DB', '--remote', '--json', '--command', 'create table x (a)']],
    [
      'PRAGMA',
      ['d1', 'execute', 'DB', '--remote', '--json', '--command', 'pragma foreign_keys=off'],
    ],
    ['ATTACH', ['d1', 'execute', 'DB', '--remote', '--json', '--command', "attach 'x' as y"]],
    ['VACUUM', ['d1', 'execute', 'DB', '--remote', '--json', '--command', 'vacuum']],
    [
      'a keyword after a literal',
      ['d1', 'execute', 'DB', '--remote', '--json', '--command', "select 'a'; drop table users"],
    ],
  ])('AC-OPS-06 refuses d1 execute --remote with %s', (_name, args) => {
    const { result, invocations } = gated(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('d1 execute --remote may only run as');
    expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(false);
  });

  describe('R-BAK-06 a restore database wrangler.jsonc does not bind', () => {
    const restoreDb = (...rest: string[]) => ['d1', 'execute', 'restored', '--remote', ...rest];
    const executed = (invocations: Invocation[], args: string[]) =>
      invocations.some((entry) => entry.args.join(' ') === args.join(' '));

    it.each([
      RESTORE_TARGET_TABLES,
      RESTORE_FOREIGN_KEY_CHECK,
      RESTORE_MEDIA_SELECT,
      RESTORE_ACCESS_SUB_LEFT,
      RESTORE_SETUP_STATE_SELECT,
      restoreCountSelect('push_subscriptions'),
    ])('runs the pinned read-only check: %s', (sql) => {
      const args = restoreDb('--json', '--command', sql);
      const { result, invocations } = gated(args);
      expect(result.status).toBe(0);
      expect(executed(invocations, args)).toBe(true);
    });

    it.each([
      ['a plain read that is not pinned', 'select * from users'],
      [
        'two pinned reads in one command',
        `${RESTORE_ACCESS_SUB_LEFT};\n${RESTORE_SETUP_STATE_SELECT}`,
      ],
      ['a count with a write after it', 'SELECT count(*) AS n FROM users; DELETE FROM users'],
      ['a pinned read with a trailing space', `${RESTORE_SETUP_STATE_SELECT} `],
      ['the push clear', RESTORE_CLEAR_PUSH_SUBSCRIPTIONS],
      ['the access_sub clear', RESTORE_CLEAR_ACCESS_SUB],
      ['the lock', RESTORE_LOCK_SETUP],
      ['the chat insert', RESTORE_CHAT_INSERT],
      ['a delete', 'delete from users'],
      ['a pragma', 'PRAGMA foreign_key_check'],
    ])('refuses %s', (_name, sql) => {
      const { result, invocations } = gated(restoreDb('--json', '--command', sql));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('d1 execute --remote may only run as');
      expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(false);
    });

    it('imports a --file into a database that holds no table, after checking that', () => {
      const args = restoreDb('--file', 'database.sql');
      const { result, invocations } = gated(args);
      expect(result.status).toBe(0);
      const check = restoreDb('--json', '--command', RESTORE_TARGET_TABLES).join(' ');
      const order = invocations.map((entry) => entry.args.join(' '));
      expect(order.indexOf(check)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(args.join(' '))).toBeGreaterThan(order.indexOf(check));
    });

    it('refuses a --file into a database that already holds tables', () => {
      const args = restoreDb('--file', 'database.sql');
      const { result, invocations } = gated(args, {
        FAKE_RESTORE_TABLES: JSON.stringify([{ name: 'users' }]),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('already holds tables');
      expect(executed(invocations, args)).toBe(false);
    });

    it.each([
      ['an extra flag', restoreDb('--file', 'database.sql', '--yes')],
      ['a flag as the file', restoreDb('--file', '--yes')],
      ['--command without --json', restoreDb('--command', RESTORE_ACCESS_SUB_LEFT)],
    ])('refuses %s', (_name, args) => {
      const { result, invocations } = gated(args);
      expect(result.status).not.toBe(0);
      expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(false);
    });

    it.each(['classhub', '33333333-3333-4333-8333-333333333333'])(
      'refuses the bound database named as %s, even for a pinned read or an import',
      (name) => {
        writeWranglerConfigSource(
          JSON.stringify({
            name: 'classhub',
            account_id: account,
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'classhub',
                database_id: '33333333-3333-4333-8333-333333333333',
              },
            ],
          }),
        );
        for (const args of [
          ['d1', 'execute', name, '--remote', '--json', '--command', RESTORE_ACCESS_SUB_LEFT],
          ['d1', 'execute', name, '--remote', '--file', 'database.sql'],
        ]) {
          const { result, invocations } = gated(args);
          expect(result.status).not.toBe(0);
          expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(false);
        }
      },
    );
  });

  it.each([
    "select 'drop table alter create pragma' as word",
    "insert into site_settings (key, value_json, updated_at) values ('setup_state', '\"locked\"', 1) on conflict (key) do update set value_json = excluded.value_json, updated_by = null, updated_at = excluded.updated_at",
    "insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) values ('a', null, 'site.locked', 'site_settings', 'setup_state', 1)",
    "select count(*) as n from users where role = 'admin' and status = 'active'",
    'select name from d1_migrations order by id;\nselect count(*) as n from backup_runs where verified_at is not null',
  ])(
    'AC-OPS-06 passes the d1 execute shapes setup, invite, unlock and preflight send: %s',
    (sql) => {
      const { result, invocations } = gated([
        'd1',
        'execute',
        'DB',
        '--remote',
        '--json',
        '--command',
        sql,
      ]);
      expect(result.status).toBe(0);
      expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(true);
    },
  );

  const execute = (sql: string) => ['d1', 'execute', 'DB', '--remote', '--json', '--command', sql];

  it.each([
    ['a quote inside a -- comment', "select 1 -- '\ndrop table media;\n-- '"],
    ['a quote inside a double-quoted identifier', 'select "\'"; drop table users; select "\'"'],
    ['a block comment', 'select 1 /* x */'],
    ['a line comment', 'select 1 -- nothing'],
    [
      'a forged backup_runs insert',
      "insert into backup_runs (id,kind,manifest_sha256,object_count,total_bytes,verified_at) values ('x','full','x',0,0,99999999999999)",
    ],
    ['an upper-case replace into backup_runs', "REPLACE INTO backup_runs (id) VALUES ('x')"],
    ['a quoted backup_runs insert', 'INSERT INTO "backup_runs" (id) VALUES (\'x\')'],
    ['an update of d1_migrations', "update d1_migrations set name = 'x'"],
    ['a delete from d1_migrations', 'delete from d1_migrations'],
  ])('AC-OPS-06 refuses d1 execute --remote with %s', (_name, sql) => {
    const { result, invocations } = gated(execute(sql));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('d1 execute --remote may only run as');
    expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(false);
  });

  it.each([
    ['migrations apply', ['d1', 'migrations', 'apply', 'DB']],
    ['execute', ['d1', 'execute', 'DB', '--json', '--command', 'drop table media']],
  ])('AC-OPS-06 refuses every remote spelling but the bare --remote on d1 %s', (_name, base) => {
    destructive();
    for (const flag of [
      '--remote=true',
      '--remote=false',
      '--no-remote',
      '--no-local',
      '--local=false',
      '--local=0',
      '-r',
      '-rl',
    ]) {
      rmSync(logPath, { force: true });
      const { result, invocations } = gated([...base, flag]);
      expect(result.status, flag).not.toBe(0);
      expect(result.stderr, flag).toContain('bare --remote');
      expect(
        invocations.some((entry) => entry.args[0] === 'd1'),
        flag,
      ).toBe(false);
    }
    // --local beside --remote is a conflict, not a way around the gates.
    const both = gated([...base, '--remote', '--local']);
    expect(both.result.status).not.toBe(0);
    expect(both.invocations.some((entry) => entry.args[0] === 'd1')).toBe(false);
  });

  it('AC-OPS-06 passes the writes the scripts really send, and reads of the two guarded tables', () => {
    for (const sql of [
      "update site_settings set value_json = '\"x\"' where key = 'setup_state'",
      "insert into users (id, name) values ('a', 'o''neil -- not a comment')",
      'select name from d1_migrations order by id',
      'select max(verified_at) as at from backup_runs where verified_at is not null',
    ]) {
      const { result, invocations } = gated(execute(sql));
      expect(result.status, sql).toBe(0);
      expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(true);
    }
  });

  it('AC-OPS-06 leaves a local d1 execute alone', () => {
    const { result, invocations } = gated(['d1', 'execute', 'DB', '--file', 'x.sql']);
    expect(result.status).toBe(0);
    expect(invocations.some((entry) => entry.args[1] === 'execute')).toBe(true);
  });
});
