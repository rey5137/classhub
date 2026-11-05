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
  async function runApi(args: string[], options: { base?: string; config?: string } = {}) {
    if (options.config) writeWranglerConfigSource(options.config);
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [cfScript, ...args], {
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
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  }

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
});
