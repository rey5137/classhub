// R-OPS-11: `npm run unlock` opens the site only when preflight passes; `npm run
// lock` closes it at once (an emergency switch, no checks). Both are audited.

import { d1Remote } from './cf-child.mjs';
import { quote } from './invite.mjs';
import { report, runPreflight } from './preflight.mjs';

/**
 * @param {import('./cf-child.mjs').CfRunner} run @param {'locked' | 'unlocked'} state
 * @param {() => string} uuid @param {number} now
 */
function setState(run, state, uuid, now) {
  return d1Remote(run, [
    `insert into site_settings (key, value_json, updated_at) values ('setup_state', ${quote(JSON.stringify(state))}, ${now}) on conflict (key) do update set value_json = excluded.value_json, updated_by = null, updated_at = excluded.updated_at`,
    `insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) values (${quote(uuid())}, null, ${quote(state === 'unlocked' ? 'site.unlocked' : 'site.locked')}, 'site_settings', 'setup_state', ${now})`,
    `select count(*) as n from users where role = 'admin' and status = 'active'`,
  ]);
}

/**
 * @param {import('./preflight.mjs').PreflightDeps & { out: (line: string) => void; uuid: () => string }} deps
 * @returns {Promise<number>}
 */
export async function runUnlock(deps) {
  if (report(await runPreflight(deps), deps.out) !== 0) {
    deps.out('Unlock refused: the site stays locked until every check passes.');
    return 1;
  }
  const results = await setState(deps.run, 'unlocked', deps.uuid, deps.now ?? Date.now());
  deps.out('Unlocked: approved members can now use the site.');
  // R-AUTH-14: one admin who leaves would strand the class.
  if (Number(results.at(-1)?.[0]?.n ?? 0) < 2) {
    deps.out(
      'Recommended: add a second admin, so the site never depends on one person: npm run invite -- add <email> --role admin',
    );
  }
  return 0;
}

/**
 * @param {{ run: import('./cf-child.mjs').CfRunner; out: (line: string) => void; uuid: () => string; now?: number }} deps
 * @returns {Promise<number>}
 */
export async function runLock(deps) {
  await setState(deps.run, 'locked', deps.uuid, deps.now ?? Date.now());
  deps.out(
    'Locked: every page now shows /locked and every API answers 423. npm run unlock reopens it.',
  );
  return 0;
}
