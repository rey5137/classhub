import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDeploy } from '../../scripts/lib/deploy-check.mjs';
import { runSmokeTest } from '../../scripts/lib/smoke-test.mjs';
import { ACCOUNT, createSandbox, type Sandbox } from '../fixtures/script-sandbox';

// R-OPS-08 (deploy's schema guard and Access vars), R-OPS-09 (smoke:test) and the
// unlock/lock CLIs end to end through scripts/cf.mjs against the fakes (AC-OPS-05).

let box: Sandbox;
const ADMIN = 'admin@example.test';
const setupFlags = ['--slug', 'classhub', '--admin', ADMIN];

beforeEach(async () => {
  box = await createSandbox();
});

afterEach(() => box.close());

function settingState() {
  const db = box.d1();
  const value = db
    .prepare(`select value_json from site_settings where key = 'setup_state'`)
    .pluck()
    .get();
  db.close();
  return value;
}

describe('deploy schema guard (R-OPS-08)', () => {
  const deploy = (env: Record<string, string> = {}) => {
    const lines: string[] = [];
    const writes: string[] = [];
    return checkDeploy({
      run: box.runner,
      root: box.dir,
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ...env },
      write: (path, text) => {
        writes.push(path);
        writeFileSync(path, text);
      },
      out: (line) => lines.push(line),
    }).then((code) => ({ code, lines, writes }));
  };

  beforeEach(async () => {
    expect((await box.run('setup.mjs', setupFlags)).status).toBe(0);
  });

  it('R-OPS-08 refuses when the deployed schema is ahead of the code', async () => {
    const db = box.d1();
    db.prepare(`insert into d1_migrations (name) values ('0002_future.sql')`).run();
    db.close();

    const { code, lines, writes } = await deploy({ ACCESS_AUD: 'aud-1' });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Deploy refused');
    expect(lines.join('\n')).toContain('0002_future.sql');
    expect(writes).toEqual([]);
  });

  it('R-OPS-08 refuses when the remote schema version cannot be read', async () => {
    box.writeState({ ...box.readState(), failures: { 'd1 execute': 'Authentication error' } });
    const { code, lines } = await deploy();
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('cannot read the remote schema version');
  });

  it('R-OPS-08 lets a current or older schema deploy (pending migrations are preflight’s call)', async () => {
    const db = box.d1();
    db.prepare('delete from d1_migrations').run();
    db.close();
    expect((await deploy()).code).toBe(0);
  });

  it('R-AUTH-05 writes the Access vars from .env.cloudflare, and leaves the file alone when they match', async () => {
    const path = join(box.dir, 'wrangler.jsonc');
    const first = await deploy({ ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: 'aud-1' });
    expect(first.code).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      account_id: ACCOUNT,
      vars: { ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: 'aud-1' },
    });

    const commented = `// kept\n${readFileSync(path, 'utf8')}`;
    writeFileSync(path, commented);
    const second = await deploy({ ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: 'aud-1' });
    expect(second.writes).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(commented);
  });
});

describe('smoke:test (R-OPS-09)', () => {
  const TEAM = 'myteam.cloudflareaccess.com';
  const HOST = 'classhub.sub.workers.dev';

  function site(health: () => Response, page: () => Response) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeDefined();
      const url = String(input);
      if (url === `https://${HOST}/health`) return health();
      if (url === `https://${HOST}/`) return page();
      throw new TypeError('fetch failed');
    }) as typeof fetch;
  }
  const healthy = () => Response.json({ ok: true, version: '0.1.0' });
  const guarded = () =>
    new Response(null, {
      status: 302,
      headers: { location: `https://${TEAM}/cdn-cgi/access/login/${HOST}` },
    });
  const smoke = (doFetch: typeof fetch, hosts = [HOST]) => {
    const lines: string[] = [];
    return runSmokeTest({
      fetch: doFetch,
      hosts,
      team: TEAM,
      version: '0.1.0',
      out: (line) => lines.push(line),
    }).then((code) => ({ code, lines }));
  };

  it('R-OPS-09 passes when /health answers and the site redirects to Access', async () => {
    const { code, lines } = await smoke(site(healthy, guarded));
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe('Smoke test: passed.');
  });

  it.each([
    ['/health is behind Access', () => guarded(), guarded, '/health: HTTP 302'],
    [
      '/health is not the health body',
      () => Response.json({ ok: false }),
      guarded,
      'not { ok: true',
    ],
    [
      'the deployed version is not this checkout',
      () => Response.json({ ok: true, version: '0.0.9' }),
      guarded,
      'runs 0.0.9; this checkout is 0.1.0',
    ],
    [
      'the site answers without a cookie',
      healthy,
      () => new Response('<html>'),
      'answered HTTP 200',
    ],
    [
      'the site redirects somewhere else',
      healthy,
      () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }),
      'not a redirect to myteam.cloudflareaccess.com',
    ],
  ])('R-OPS-09 fails when %s', async (_name, health, page, reason) => {
    const { code, lines } = await smoke(site(health, page));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(reason);
  });

  it('R-OPS-09 fails when the host does not answer, and when no host is known', async () => {
    expect((await smoke(site(healthy, guarded), ['down.example.test'])).code).toBe(1);
    const none = await smoke(site(healthy, guarded), []);
    expect(none.code).toBe(1);
    expect(none.lines[0]).toContain('no hostname is known');
  });
});

describe('npm run unlock / lock through cf.mjs (R-OPS-11)', () => {
  beforeEach(async () => {
    expect((await box.run('setup.mjs', setupFlags)).status).toBe(0);
    // No workers.dev subdomain and no Access vars: preflight fails without any network read.
    box.writeState({ ...box.readState(), subdomain: undefined });
  });

  it('AC-OPS-05 unlock refuses while preflight fails; the site stays locked', async () => {
    const result = await box.run('unlock.mjs');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL  access: not set in wrangler.jsonc');
    expect(result.stdout).toContain('Unlock refused');
    expect(settingState()).toBe('"locked"');
    // Every Cloudflare read went through the account guard's whoami first.
    expect(result.calls[0]).toEqual(['whoami', '--json']);
  });

  it('AC-OPS-05 lock sets the site locked at once', async () => {
    const db = box.d1();
    db.prepare(
      `update site_settings set value_json = '"unlocked"' where key = 'setup_state'`,
    ).run();
    db.close();

    const result = await box.run('unlock.mjs', ['--lock']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Locked');
    expect(settingState()).toBe('"locked"');
  });

  it('refuses an unknown argument without touching D1', async () => {
    const result = await box.run('unlock.mjs', ['--force']);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
  });
});
