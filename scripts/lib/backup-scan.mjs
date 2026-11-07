// R-BAK-01 / AC-BAK-08: no file of a snapshot holds the account id or a token, and no file the
// backup writes itself names a provider URL.
// `backup` scans its staging before encrypting; `verify-backup` scans whatever it is given.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './env-file.mjs';

// The hosts R-BAK-17 names. Written as patterns so AC-PLAT-07's endpoint grep, which keeps the
// literal hostnames inside cf.mjs and s3.mjs, still holds: this module never calls them.
const PROVIDER_HOSTS = [
  { label: 'the R2 S3 endpoint', pattern: /r2\.cloudflarestorage\.com/i },
  { label: 'the Cloudflare API host', pattern: /api\.cloudflare\.com/i },
];

// The account id and every token or key `.env.cloudflare` holds, plus the Access team domain
// (an account-specific provider URL). The age recipient is a public key and stays out.
const SECRET_NAMES = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_HOUSEKEEPING_ACCESS_KEY_ID',
  'R2_HOUSEKEEPING_SECRET_ACCESS_KEY',
  'R2_RESTORE_ACCESS_KEY_ID',
  'R2_RESTORE_SECRET_ACCESS_KEY',
  'ACCESS_AUD',
  'ACCESS_TEAM_DOMAIN',
];
// A host, not a credential: members and admins may write it (the logout link, a how-to page).
const HOST_NAMES = new Set(['ACCESS_TEAM_DOMAIN']);
// Row ids listed per finding and file; the rest are counted.
const MAX_ROW_IDS = 10;
// Shorter than this, a value could match ordinary text; no real id, key or domain is.
const MIN_SECRET_LENGTH = 8;

/** @typedef {{ name: string; value: string }} Secret */

/**
 * The values to look for, by variable name (only the name is ever printed).
 * @param {Record<string, string> | null | undefined} values
 * @returns {Secret[]}
 */
export function secretsFrom(values) {
  return SECRET_NAMES.flatMap((name) => {
    const value = values?.[name]?.trim() ?? '';
    return value.length >= MIN_SECRET_LENGTH ? [{ name, value }] : [];
  });
}

/** `.env.cloudflare` at the project root, when this machine has one. @param {string} root */
export function secretsFromEnvFile(root) {
  return secretsFrom(readEnvFile(join(root, '.env.cloudflare')));
}

/** @typedef {{ errors: string[]; warnings: string[] }} ScanResult */

/**
 * Every file except the photo bytes under `objects/` (member uploads, not text the export
 * wrote). An account id or token fails anywhere. A provider host or the team domain fails in
 * the files the backup writes itself, and is only a warning in `content`: the dump and the
 * NDJSON tables, which hold what members and admins wrote. A hit in an NDJSON table names the
 * table and the row ids. Messages name the file and what it holds, never the value.
 * @param {string} dir @param {string[]} files snapshot-relative paths
 * @param {Secret[]} secrets
 * @param {Map<string, string | null>} [content] content file → its table (null: the SQL dump)
 * @returns {ScanResult}
 */
export function scanForSecrets(dir, files, secrets, content = new Map()) {
  /** @type {ScanResult} */
  const result = { errors: [], warnings: [] };
  const findings = [
    ...PROVIDER_HOSTS.map((host) => ({
      label: host.label,
      host: true,
      test: (/** @type {string} */ text) => host.pattern.test(text),
    })),
    ...secrets.map((secret) => ({
      label: HOST_NAMES.has(secret.name) ? `the ${secret.name} host` : `the ${secret.name} value`,
      host: HOST_NAMES.has(secret.name),
      test: (/** @type {string} */ text) => text.includes(secret.value),
    })),
  ];
  for (const file of files) {
    if (file.startsWith('objects/')) continue;
    const table = content.get(file);
    const text = readFileSync(join(dir, file), table ? 'utf8' : 'latin1');
    for (const finding of findings) {
      if (!finding.test(text)) continue;
      const where = table ? ` in ${table} ${rowIds(text, finding.test)}` : '';
      const message = `${file} contains ${finding.label}${where}.`;
      if (finding.host && content.has(file)) result.warnings.push(message);
      else result.errors.push(message);
    }
  }
  return result;
}

/**
 * The ids of the NDJSON rows a finding is in (`user_id` for profile_contacts).
 * @param {string} text @param {(text: string) => boolean} test
 */
function rowIds(text, test) {
  const ids = text.split('\n').flatMap((line, index) => {
    if (!line || !test(line)) return [];
    /** @type {Record<string, unknown> | null} */
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      // Unparsable rows fail verification elsewhere; name the line instead.
    }
    const id = row?.id ?? row?.user_id;
    return [typeof id === 'string' || typeof id === 'number' ? String(id) : `line ${index + 1}`];
  });
  const more = ids.length > MAX_ROW_IDS ? ` and ${ids.length - MAX_ROW_IDS} more` : '';
  return `${ids.length === 1 ? 'row' : 'rows'} ${ids.slice(0, MAX_ROW_IDS).join(', ')}${more}`;
}
