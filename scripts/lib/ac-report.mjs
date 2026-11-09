import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// AC-BUD-05/AC-UI-03/AC-OPS-07 release check: every acceptance criterion in the
// spec is either proved by a test whose title starts with its id, or marked
// manual (review or owner step). Anything else fails the run.

const HEADER = /^\|\s*ID\s*\|\s*Criterion\s*\|\s*Rules\s*\|\s*(?:Proved by|Test)\s*\|$/i;
const SEPARATOR = /^\|(?:\s*:?-+:?\s*\|){3,}$/;
const ROW = /^\|\s*(AC-[A-Z]+-\d+)\s*\|/;

/**
 * Split a table row on unescaped pipes; `\|` is a literal pipe inside a cell.
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  const inner = line.slice(1, line.endsWith('|') ? -1 : undefined);
  const cells = [];
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '\\' && inner[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Every AC row of every acceptance table in one Markdown document.
 * @param {string} markdown
 * @param {string} [file]
 * @returns {{ id: string; criterion: string; rules: string; provedBy: string; file: string; line: number }[]}
 */
export function parseAcTables(markdown, file = '') {
  const lines = markdown.split('\n');
  /** @type {{ id: string; criterion: string; rules: string; provedBy: string; file: string; line: number }[]} */
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!HEADER.test(lines[index].trim())) continue;
    if (!SEPARATOR.test((lines[index + 1] ?? '').trim())) continue;
    for (let row = index + 2; row < lines.length; row += 1) {
      const line = lines[row].trim();
      if (!ROW.test(line)) break;
      const cells = splitRow(line);
      rows.push({
        id: cells[0],
        criterion: cells[1] ?? '',
        rules: cells[2] ?? '',
        provedBy: cells.slice(3).join('|').trim(),
        file,
        line: row + 1,
      });
    }
    index += 2;
  }
  return rows;
}

/**
 * AC ids that start a test or describe title, across the given test sources.
 * @param {{ file: string; text: string }[]} sources
 * @returns {Map<string, string[]>} id → files naming it
 */
export function coveredAcIds(sources) {
  /** @type {Map<string, string[]>} */
  const covered = new Map();
  // A title may start with several ids (`AC-AUTH-01 AC-AUTH-02 …`).
  const pattern =
    /\b(?:it|test|describe)(?:\.(?!(?:skip|todo|fails|skipIf|runIf)\b)\w+(?:\([^)]*\))?)?\s*\(\s*(['"`])((?:AC-[A-Z]+-\d+(?:[,\s]+|(?=['"`])))+)/g;
  for (const { file, text } of sources) {
    for (const match of stripComments(text).matchAll(pattern)) {
      for (const id of match[2].match(/AC-[A-Z]+-\d+/g) ?? []) {
        const files = covered.get(id) ?? [];
        if (!files.includes(file)) files.push(file);
        covered.set(id, files);
      }
    }
  }
  return covered;
}

/**
 * A criterion that is not automated: a manual/review/owner step, a release
 * command an owner runs, or a criterion the spec defers.
 * @param {string} provedBy
 * @param {string} [criterion]
 * @param {boolean} [ciVerifies] a `CI` part counts when the CI workflow runs `npm run verify`
 */
export function isManual(provedBy, criterion = '', ciVerifies = false) {
  return automatedSegments(provedBy, criterion, ciVerifies).length === 0;
}

/**
 * The parts of a proved-by cell (split on `+`, `,`, `;`) that need an automated
 * test. Empty when every part is manual, or the criterion is deferred.
 * @param {string} provedBy
 * @param {string} [criterion]
 * @param {boolean} [ciVerifies]
 * @returns {string[]}
 */
export function automatedSegments(provedBy, criterion = '', ciVerifies = false) {
  if (/\bdeferred\b/i.test(criterion)) return [];
  const MANUAL = /\b(manual|review|owner)\b|^n\/a$|^(?:npm|npx) run\b/i;
  const AUTOMATED = /\b(unit|integration|e2e|workers|migrations?)\b|test:|`/i;
  let previousManual = false;
  return provedBy
    .split(/[+,;]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => {
      const plain = segment.replace(/`/g, '');
      if (/^CI\b/.test(plain)) {
        previousManual = ciVerifies;
        return !ciVerifies;
      }
      // A segment naming no kind ("repeated 6b") takes the kind of the one before it.
      const manual = MANUAL.test(plain) ? true : AUTOMATED.test(segment) ? false : previousManual;
      previousManual = manual;
      return !manual;
    });
}

/**
 * Lines that start an AC row (`| AC-…`) in one Markdown document.
 * @param {string} markdown
 */
export function countAcLines(markdown) {
  return markdown.split('\n').filter((line) => /^\|\s*AC-/.test(line)).length;
}

/**
 * Drop commented lines so a commented-out title proves nothing.
 * @param {string} text
 */
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/**
 * @param {{ id: string; criterion?: string; provedBy: string; file: string; line: number }[]} rows
 * @param {Map<string, string[]>} covered
 * @param {boolean} [ciVerifies]
 * @returns {{ id: string; status: 'covered' | 'manual' | 'MISSING'; files: string[]; provedBy: string; file: string; line: number }[]}
 */
export function classify(rows, covered, ciVerifies = false) {
  return rows.map((row) => {
    const files = covered.get(row.id) ?? [];
    if (files.length > 0) return { ...row, status: 'covered', files };
    if (isManual(row.provedBy, row.criterion, ciVerifies))
      return { ...row, status: 'manual', files };
    return { ...row, status: 'MISSING', files };
  });
}

/** @param {string} dir @param {RegExp} pattern */
export function readTree(dir, pattern) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...readTree(path, pattern));
    else if (pattern.test(entry.name)) files.push(path);
  }
  return files;
}

/**
 * A row the parser skipped (odd header, broken table) would escape the report.
 * @param {number} lines `| AC-` lines in the spec
 * @param {number} parsed rows the parser returned
 */
export function assertAllRowsParsed(lines, parsed) {
  if (lines !== parsed)
    throw new Error(
      `${lines} AC lines in docs/spec but ${parsed} rows parsed; fix the table headers`,
    );
}

/** @param {string} root */
export function collectReport(root) {
  const specFiles = readTree(join(root, 'docs', 'spec'), /\.md$/);
  const specTexts = specFiles.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  const rows = specTexts.flatMap(({ file, text }) =>
    parseAcTables(text, file.slice(root.length + 1)),
  );
  assertAllRowsParsed(
    specTexts.reduce((sum, { text }) => sum + countAcLines(text), 0),
    rows.length,
  );
  const testFiles = readTree(join(root, 'tests'), /\.(?:ts|mjs)$/);
  const sources = testFiles.map((file) => ({
    file: file.slice(root.length + 1),
    text: readFileSync(file, 'utf8'),
  }));
  const ci = join(root, '.github', 'workflows', 'ci.yml');
  const ciVerifies =
    existsSync(ci) && /^\s*-?\s*run:\s*npm run verify\s*$/m.test(readFileSync(ci, 'utf8'));
  return classify(rows, coveredAcIds(sources), ciVerifies);
}

/**
 * @param {ReturnType<typeof classify>} results
 * @param {(line: string) => void} [out]
 * @returns {number} exit code
 */
export function report(results, out = console.log) {
  for (const result of results) {
    const where = result.files.length > 0 ? ` (${result.files.join(', ')})` : '';
    out(`${result.status.padEnd(7)} ${result.id}${where}`);
  }
  const count = (/** @type {'covered' | 'manual' | 'MISSING'} */ status) =>
    results.filter((result) => result.status === status).length;
  const missing = results.filter((result) => result.status === 'MISSING');
  out('');
  out(
    `ac:report: ${results.length} criteria, ${count('covered')} covered, ${count('manual')} manual, ${missing.length} MISSING`,
  );
  if (missing.length > 0) {
    out('MISSING:');
    for (const result of missing)
      out(`  ${result.id} (${result.file}:${result.line}) ${result.provedBy}`);
  }
  return missing.length > 0 ? 1 : 0;
}
