import { spawnSync } from 'node:child_process';

/** The seeded demo admin the local launchers sign in as (R-PLAT-10). */
export const DEV_MEMBER = 'admin@example.com';

/**
 * The dev identity lets nobody in unless CLASSHUB_DEV_MEMBER names an active
 * member, so a launcher that starts `dev:offline` seeds the demo data first and
 * signs in as its admin. A caller's own CLASSHUB_DEV_MEMBER wins.
 * @param {string} root
 * @returns {NodeJS.ProcessEnv}
 */
export function devMemberEnv(root) {
  const seeded = spawnSync('npm', ['run', 'db:seed:demo'], { cwd: root, stdio: 'ignore' });
  if (seeded.status !== 0) throw new Error('db:seed:demo failed');
  return {
    ...process.env,
    CLASSHUB_OFFLINE: '1',
    CLASSHUB_DEV_MEMBER: process.env.CLASSHUB_DEV_MEMBER ?? DEV_MEMBER,
  };
}
