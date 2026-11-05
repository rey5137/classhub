// R-AUTH-18: the app's invite list in D1 plus, when the token may, the Access
// application's email include rule. The Worker never holds a Cloudflare token, so
// this is the only place the policy changes. Pure over its two injected sides so
// tests run it against SQLite and a fake Access API (AC-AUTH-11).

import { normalizeEmail, normalizeName } from '../../src/lib/shared/normalize.ts';
import { SEAT_LIMIT } from '../../src/lib/shared/seats.ts';
import { reason } from './cf-child.mjs';

export { normalizeEmail, SEAT_LIMIT };

const DAY = 86_400_000;
const EMAIL = /^[^\s@'"\\;]+@[^\s@'"\\;]+\.[^\s@'"\\;]+$/;

/**
 * @typedef {(statements: string[]) => Promise<Record<string, unknown>[][]>} D1Exec
 *   Runs the statements in order and returns each one's rows.
 * @typedef {{ emails(): Promise<string[]>; setEmails(emails: string[]): Promise<void> }} AccessPolicy
 * @typedef {{ d1: D1Exec; access: AccessPolicy | null; out: (line: string) => void; now?: number; uuid: () => string; expiryDays: number | null }} InviteDeps
 *   `expiryDays` is `invite.expiryDays` from site.config.ts (R-AUTH-08); null never expires.
 */

export class AccessScopeError extends Error {
  name = 'AccessScopeError';
}

/** SQLite string literal; the email is validated first, this is the second wall. */
export function quote(/** @type {string | null} */ value) {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

/** An address the invite list accepts (also refuses SQL and shell metacharacters). */
export function validEmail(/** @type {string} */ email) {
  return EMAIL.test(email) && email.length <= 254;
}

/** R-AUTH-19: active members plus live invites, as one SQL expression. */
export function seatsUsedSql(/** @type {number} */ now) {
  return `((select count(*) from users where status = 'active') + (select count(*) from invites where status = 'pending' and (expires_at is null or expires_at > ${now})))`;
}

/** @param {string} email */
export function dashboardStep(email, action = 'add') {
  return [
    `Access policy not changed. In the Cloudflare dashboard: Zero Trust → Access → Applications →`,
    `  your Class Hub application → Policies → the Allow policy → Include → Emails:`,
    `  ${action === 'add' ? 'add' : 'remove'} ${email}, then save.`,
    `  (A token with "Access: Apps and Policies · Edit" lets npm run invite do this for you.)`,
  ].join('\n');
}

/**
 * @param {string[]} argv
 * @returns {{ command: 'list' } | { command: 'add'; email: string; name: string; role: 'member' | 'admin' } | { command: 'remove'; email: string }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = /** @type {Record<string, string>} */ ({});
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] ?? '';
    if (value === '--name' || value === '--role') flags[value.slice(2)] = rest[++index] ?? '';
    else positional.push(value);
  }
  if (command === 'list' && positional.length === 0) return { command };
  const email = normalizeEmail(positional[0] ?? '');
  if ((command !== 'add' && command !== 'remove') || positional.length !== 1) {
    throw new Error(
      'usage: npm run invite -- list | add <email> [--name "Display Name"] [--role admin] | remove <email>',
    );
  }
  if (!validEmail(email)) throw new Error(`not an email address: ${email}`);
  if (command === 'remove') return { command, email };
  const role = flags.role ?? 'member';
  if (role !== 'member' && role !== 'admin') throw new Error('--role is member or admin');
  // R-PROF-01: 1–80 characters; without --name the address's local part stands in.
  const name = (flags.name ?? email.split('@')[0] ?? '').trim().slice(0, 80);
  if (!name || /\p{Cc}/u.test(name)) throw new Error('--name needs 1–80 printable characters');
  return { command, email, name, role };
}

/** @param {InviteDeps} deps @param {string} email */
async function readRow(deps, email) {
  const [rows] = await deps.d1([
    `select i.id as invite_id, i.status as invite_status, i.expires_at, u.id as user_id, u.status as user_status, u.role as user_role
     from (select ${quote(email)} as email) e
     left join invites i on i.email = e.email
     left join users u on u.auth_email = e.email`,
  ]);
  return /** @type {{ invite_id: string | null; invite_status: string | null; expires_at: number | null; user_id: string | null; user_status: string | null; user_role: string | null }} */ (
    rows?.[0] ?? {}
  );
}

/**
 * Policy sync after the app list changed. A token without the Access scope prints
 * the dashboard step and succeeds; any other failure prints it and fails.
 * @param {InviteDeps} deps @param {string} email @param {'add' | 'remove'} action
 * @returns {Promise<number>}
 */
async function syncPolicy(deps, email, action) {
  if (!deps.access) {
    deps.out(dashboardStep(email, action));
    return 0;
  }
  try {
    const current = (await deps.access.emails()).map(normalizeEmail);
    const next =
      action === 'add'
        ? [...new Set([...current, email])]
        : current.filter((value) => value !== email);
    if (next.length !== current.length || next.some((value, index) => value !== current[index])) {
      await deps.access.setEmails(next);
    }
  } catch (error) {
    deps.out(dashboardStep(email, action));
    if (error instanceof AccessScopeError) return 0;
    deps.out(`Access API error: ${error instanceof Error ? error.message : 'unknown'}`);
    return 1;
  }
  const now = deps.now ?? Date.now();
  // R-AUTH-10: the screen's "in the Access policy" label follows this column, so a
  // removal clears it rather than stamping it.
  await deps.d1([
    `update invites set access_synced_at = ${action === 'add' ? String(now) : 'NULL'} where email = ${quote(email)}`,
  ]);
  deps.out(`Access policy ${action === 'add' ? 'now includes' : 'no longer includes'} ${email}.`);
  return 0;
}

/** @param {InviteDeps} deps @param {string} email @param {string} name @param {'member' | 'admin'} role */
async function add(deps, email, name, role) {
  const now = deps.now ?? Date.now();
  const row = await readRow(deps, email);
  const live =
    row.invite_status === 'pending' && (row.expires_at === null || Number(row.expires_at) > now);
  if (row.user_status === 'suspended' && row.invite_status === 'accepted') {
    // R-AUTH-09: the inverse of `remove`. Same guard and audit action as the app's
    // reactivateMember; the policy follows only when the status really changed.
    const userId = quote(String(row.user_id));
    const guard = `id = ${userId} and status = 'suspended' and exists (select 1 from invites where invites.email = users.auth_email and invites.status = 'accepted')`;
    await deps.d1([
      `insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) select ${quote(deps.uuid())}, NULL, 'member.reactivated', 'user', ${userId}, ${now} where exists (select 1 from users where ${guard})`,
      `update users set status = 'active', updated_at = ${now} where ${guard}`,
    ]);
    if ((await readRow(deps, email)).user_status !== 'active') {
      deps.out(`${email} could not be reactivated; nothing changed.`);
      return 1;
    }
    deps.out(`Reactivated ${email}.`);
  } else if (row.invite_status === 'accepted' || row.user_status === 'active') {
    deps.out(`${email} is already a member.`);
  } else if (live) {
    deps.out(`${email} already has a pending invite.`);
  } else {
    const seatsUsed = seatsUsedSql(now);
    const [[seats] = []] = await deps.d1([`select ${seatsUsed} as used`]);
    if (Number(seats?.used ?? 0) >= SEAT_LIMIT) {
      deps.out(`All ${SEAT_LIMIT} seats are taken (R-AUTH-19); nothing changed.`);
      return 1;
    }
    // `invites.invited_by` must name a member: the bootstrap admin, else any active admin.
    const [[inviter] = []] = await deps.d1([
      `select u.id from users u left join invites i on i.email = u.auth_email and i.invited_by = u.id
       where u.role = 'admin' and u.status in ('active', 'invited') order by i.id is null, u.created_at limit 1`,
    ]);
    if (!inviter?.id) {
      deps.out('No admin exists yet: run npm run setup first.');
      return 1;
    }
    const by = quote(String(inviter.id));
    const expires = deps.expiryDays === null ? 'NULL' : String(now + deps.expiryDays * DAY);
    const inviteId = row.invite_id ?? deps.uuid();
    // R-AUTH-19: the seat check above is advisory; the invite write re-checks it in the
    // same statement, and the user row and audit follow only once the invite is live.
    const seatFree = `${seatsUsed} < ${SEAT_LIMIT}`;
    const live = `exists (select 1 from invites where id = ${quote(inviteId)} and status = 'pending' and (expires_at is null or expires_at > ${now}))`;
    const inviteStatement = row.invite_id
      ? `update invites set status = 'pending', role = ${quote(role)}, invited_by = ${by}, expires_at = ${expires}, access_synced_at = NULL where id = ${quote(row.invite_id)} and ${seatFree}`
      : `insert into invites (id, email, invited_by, role, status, created_at, expires_at) select ${quote(inviteId)}, ${quote(email)}, ${by}, ${quote(role)}, 'pending', ${now}, ${expires} where ${seatFree}`;
    const userStatement = row.user_id
      ? `update users set status = 'invited', role = ${quote(role)}, updated_at = ${now} where id = ${quote(row.user_id)} and status <> 'active' and ${live}`
      : `insert into users (id, auth_email, display_name, display_name_norm, role, status, created_at, updated_at) select ${quote(deps.uuid())}, ${quote(email)}, ${quote(name)}, ${quote(normalizeName(name))}, ${quote(role)}, 'invited', ${now}, ${now} where ${live}`;
    await deps.d1([
      inviteStatement,
      userStatement,
      `insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) select ${quote(deps.uuid())}, ${by}, ${quote(row.invite_id ? 'invite.renewed' : 'invite.created')}, 'invite', ${quote(inviteId)}, ${now} where ${live}`,
    ]);
    const after = await readRow(deps, email);
    if (
      after.invite_status !== 'pending' ||
      (after.expires_at !== null && Number(after.expires_at) <= now)
    ) {
      deps.out(`All ${SEAT_LIMIT} seats are taken (R-AUTH-19); nothing changed.`);
      return 1;
    }
    deps.out(`Invited ${email} as ${role}.`);
  }
  return syncPolicy(deps, email, 'add');
}

/**
 * R-AUTH-09: the app status changes first (immediate denial), then the policy. A
 * pending invite is revoked (R-AUTH-08); a member is suspended, never the last
 * active admin (R-NAV-06).
 * @param {InviteDeps} deps @param {string} email
 */
async function remove(deps, email) {
  const now = deps.now ?? Date.now();
  const row = await readRow(deps, email);
  if (row.invite_id || row.user_id) {
    const statements = [
      // R-NAV-06: the last-admin test is part of this statement (as keepsAnAdmin in the
      // app), so a concurrent demotion cannot leave the class without an admin.
      `update users set status = 'suspended', updated_at = ${now} where auth_email = ${quote(email)} and status <> 'suspended' and (not (role = 'admin' and status = 'active') or (select count(*) from users where role = 'admin' and status = 'active') > 1)`,
    ];
    if (row.invite_id && row.invite_status === 'pending') {
      statements.push(`update invites set status = 'revoked' where id = ${quote(row.invite_id)}`);
      statements.push(
        `insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) values (${quote(deps.uuid())}, NULL, 'invite.revoked', 'invite', ${quote(row.invite_id)}, ${now})`,
      );
    }
    if (row.user_id && row.user_status === 'active') {
      statements.push(
        `insert into audit_events (id, actor_id, action, entity_type, entity_id, created_at) select ${quote(deps.uuid())}, NULL, 'member.suspended', 'user', ${quote(row.user_id)}, ${now} where exists (select 1 from users where id = ${quote(row.user_id)} and status = 'suspended')`,
      );
    }
    await deps.d1(statements);
    const after = await readRow(deps, email);
    if (row.user_status === 'active' && after.user_status === 'active') {
      deps.out(`${email} is the last active admin (R-NAV-06); nothing changed.`);
      return 1;
    }
    // Only a row that was `invited` before this change may go, and only while it shows
    // no sign of membership (as revokeInvite in the app); any other row stays suspended.
    if (row.user_id && row.user_status === 'invited') {
      try {
        await deps.d1([
          `delete from users where id = ${quote(row.user_id)} and status = 'suspended' and access_sub is null and last_seen_at is null and not exists (select 1 from profile_contacts where user_id = users.id)`,
        ]);
      } catch {
        /* referenced (FK RESTRICT): keep it suspended */
      }
    }
    deps.out(`Removed ${email} from the class list.`);
  } else {
    deps.out(`${email} is not on the class list.`);
  }
  return syncPolicy(deps, email, 'remove');
}

/** @param {InviteDeps} deps */
async function list(deps) {
  const now = deps.now ?? Date.now();
  const [rows = []] = await deps.d1([
    `select i.email, i.status, i.expires_at, i.access_synced_at, u.status as user_status, u.role
     from invites i left join users u on u.auth_email = i.email order by i.email`,
  ]);
  /** @type {Set<string> | null} */
  let policy = null;
  if (deps.access) {
    try {
      policy = new Set((await deps.access.emails()).map(normalizeEmail));
    } catch (error) {
      deps.out(
        error instanceof AccessScopeError
          ? 'The token cannot read the Access policy; showing the app list only.'
          : `Access API error: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
  for (const row of rows) {
    const expired =
      row.status === 'pending' && row.expires_at !== null && Number(row.expires_at) <= now;
    const state = row.user_status === 'suspended' ? 'suspended' : expired ? 'expired' : row.status;
    const where =
      policy === null
        ? 'access: unknown'
        : policy.has(String(row.email))
          ? 'app + access'
          : 'app only';
    deps.out(`${row.email}\t${state}\t${row.role ?? '-'}\t${where}`);
  }
  if (policy) {
    const known = new Set(rows.map((row) => String(row.email)));
    for (const email of policy) if (!known.has(email)) deps.out(`${email}\t-\t-\taccess only`);
  }
  if (!deps.access) deps.out('Access policy: not checked (no Access-scoped token or policy id).');
  return 0;
}

/** @param {string[]} argv @param {InviteDeps} deps @returns {Promise<number>} */
export async function runInvite(argv, deps) {
  const args = parseArgs(argv);
  if (args.command === 'list') return list(deps);
  if (args.command === 'add') return add(deps, args.email, args.name, args.role);
  return remove(deps, args.email);
}

/**
 * The Access policy through `scripts/cf.mjs api` (INV-9): the account guard runs on
 * every call and the token never reaches this process. Ids come from the gitignored
 * .env.cloudflare (INV-6). The include rule's other entries and the policy's
 * `require`/`exclude` are kept as they are, so login methods (Google and the one-time
 * PIN, R-AUTH-15) are never touched.
 * @param {{ run: import('./cf-child.mjs').CfRunner; policyId: string; appId?: string }} options
 * @returns {AccessPolicy}
 */
export function createAccessPolicy(options) {
  const path = options.appId
    ? `/access/apps/${options.appId}/policies/${options.policyId}`
    : `/access/policies/${options.policyId}`;

  /** @param {string[]} args @param {string} [input] @returns {Record<string, unknown>} */
  function call(args, input) {
    const result = options.run(args, input === undefined ? {} : { input });
    if (result.status !== 0) {
      if (/\bHTTP (?:401|403)\b/.test(result.stderr)) {
        throw new AccessScopeError('token lacks Access: Apps and Policies');
      }
      throw new Error(reason(result));
    }
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* falls through */
    }
    throw new Error('the Access API answer was not JSON');
  }

  /** @param {unknown} rule */
  const emailOf = (rule) => /** @type {{ email?: { email?: unknown } }} */ (rule)?.email?.email;

  return {
    async emails() {
      const policy = call(['api', path]);
      const include = Array.isArray(policy.include) ? policy.include : [];
      return include.map(emailOf).filter((email) => typeof email === 'string');
    },
    async setEmails(emails) {
      const policy = call(['api', path]);
      const include = Array.isArray(policy.include) ? policy.include : [];
      const others = include.filter((rule) => typeof emailOf(rule) !== 'string');
      call(
        ['api', '--put', path],
        JSON.stringify({
          name: policy.name,
          decision: policy.decision,
          include: [...others, ...emails.map((email) => ({ email: { email } }))],
          exclude: policy.exclude ?? [],
          require: policy.require ?? [],
          ...(policy.precedence === undefined ? {} : { precedence: policy.precedence }),
        }),
      );
    },
  };
}
