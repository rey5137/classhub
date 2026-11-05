import { hostOf } from './worker-config.mjs';

// R-OPS-09: `npm run smoke:test` after a deploy. Without a cookie, `/health`
// answers `{ ok: true, version }` (its Access bypass, docs/GOOGLE_ACCESS.md) and
// every other path is sent to the team's Access login (R-AUTH-02).

const TIMEOUT_MS = 10_000;

/**
 * @param {{ fetch: typeof fetch; hosts: string[]; team: string; version: string; out: (line: string) => void }} deps
 * @returns {Promise<number>}
 */
export async function runSmokeTest({ fetch: doFetch, hosts, team, version, out }) {
  if (hosts.length === 0) {
    out('FAIL  no hostname is known; pass --host <hostname> or run npm run setup.');
    return 1;
  }
  let failed = 0;
  for (const host of hosts) {
    const health = await doFetch(`https://${host}/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    /** @type {{ ok?: unknown; version?: unknown } | null} */
    const body = health?.status === 200 ? await health.json().catch(() => null) : null;
    if (body?.ok !== true || typeof body.version !== 'string') {
      failed += 1;
      out(
        `FAIL  https://${host}/health: ${health ? `HTTP ${health.status}` : 'no response'}, not { ok: true, version }.`,
      );
      if (health && health.status >= 300 && health.status < 400) {
        out('      fix: add the /health bypass application (docs/GOOGLE_ACCESS.md section 4).');
      }
    } else if (body.version !== version) {
      failed += 1;
      out(
        `FAIL  https://${host}/health runs ${body.version}; this checkout is ${version}. Run npm run deploy.`,
      );
    } else out(`PASS  https://${host}/health: ok, version ${body.version}.`);

    const page = await doFetch(`https://${host}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    const target = hostOf(page?.headers.get('location') ?? '');
    if (page && page.status >= 300 && page.status < 400 && team && target === team) {
      out(`PASS  https://${host}/ without a cookie redirects to ${team}.`);
    } else {
      failed += 1;
      out(
        `FAIL  https://${host}/ without a cookie ${page ? `answered HTTP ${page.status}` : 'did not answer'}, not a redirect to ${team || 'the Access team domain'}.`,
      );
      out(
        '      fix: list this hostname in the Access application (docs/GOOGLE_ACCESS.md section 4).',
      );
    }
  }
  out(failed === 0 ? 'Smoke test: passed.' : `Smoke test: ${failed} failed.`);
  return failed === 0 ? 0 : 1;
}
