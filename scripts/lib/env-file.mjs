import { existsSync, readFileSync } from 'node:fs';

/**
 * The gitignored `.env.cloudflare` as key/value pairs (same rules as cf.mjs, which
 * keeps its own copy so its tests can run it alone). Never logged.
 * @param {string} path @returns {Record<string, string> | null}
 */
export function readEnvFile(path) {
  if (!existsSync(path)) return null;
  /** @type {Record<string, string>} */
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, equals).trim()] = value;
  }
  return values;
}
