import { describe, expect, it } from 'vitest';
import {
  assertAllRowsParsed,
  automatedSegments,
  classify,
  countAcLines,
  coveredAcIds,
  isManual,
  parseAcTables,
  report,
} from '../../scripts/lib/ac-report.mjs';

// The release report (AC-BUD-05 is a manual review AC; this proves no AC) must itself be tested.

const TABLE = `# 99 — Fixture

## Acceptance criteria

| ID | Criterion | Rules | Proved by |
|---|---|---|---|
| AC-AAA-01 | A criterion with a pipe \\| inside | R-AAA-01 | unit |
| AC-AAA-02 | A manual check | R-AAA-02 | manual 6b |
| AC-AAA-03 | A review check | R-AAA-03 | review 6a |
| AC-AAA-04 | A missing check | R-AAA-04 | integration |

| Not an AC table | Header |
|---|---|
| AC-AAA-05 | not a criterion |
`;

describe('ac:report parser', () => {
  it('parses every row of an acceptance table and ignores other tables', () => {
    const rows = parseAcTables(TABLE, 'docs/spec/99-fixture.md');
    expect(rows.map((row) => row.id)).toEqual(['AC-AAA-01', 'AC-AAA-02', 'AC-AAA-03', 'AC-AAA-04']);
    expect(rows[0]).toMatchObject({
      criterion: 'A criterion with a pipe | inside',
      rules: 'R-AAA-01',
      provedBy: 'unit',
      file: 'docs/spec/99-fixture.md',
      line: 7,
    });
  });

  it('finds ids that start a test, it.each or describe title', () => {
    const covered = coveredAcIds([
      { file: 'tests/unit/a.test.ts', text: "it('AC-AAA-01 does a thing', () => {});" },
      { file: 'tests/unit/b.test.ts', text: "it.each(cases)('AC-AAA-02 does more', () => {});" },
      { file: 'tests/e2e/c.spec.ts', text: "test('AC-AAA-04 a browser check', async () => {});" },
      { file: 'tests/unit/d.test.ts', text: "describe('AC-AAA-03 a suite', () => {});" },
      {
        file: 'tests/unit/e.test.ts',
        text: "it('AC-AAA-05 AC-AAA-06 refuses several ids named first', () => {});",
      },
      {
        file: 'tests/unit/f.test.ts',
        text: "it('AC-AAA-07, AC-AAA-08 pages with a comma list', () => {});",
      },
      {
        file: 'tests/unit/g.test.ts',
        text: "it('plan 1a, AC-AAA-01: id is not first', () => {});",
      },
    ]);
    expect([...covered.keys()].sort()).toEqual([
      'AC-AAA-01',
      'AC-AAA-02',
      'AC-AAA-03',
      'AC-AAA-04',
      'AC-AAA-05',
      'AC-AAA-06',
      'AC-AAA-07',
      'AC-AAA-08',
    ]);
    expect(covered.get('AC-AAA-01')).toEqual(['tests/unit/a.test.ts']);
  });

  it('marks a row manual from its proved-by column and MISSING otherwise', () => {
    const rows = parseAcTables(TABLE, 'docs/spec/99-fixture.md');
    const results = classify(
      rows,
      new Map([
        ['AC-AAA-01', ['tests/unit/a.test.ts']],
        ['AC-AAA-04', ['tests/e2e/c.spec.ts']],
      ]),
    );
    expect(results.map((result) => result.status)).toEqual([
      'covered',
      'manual',
      'manual',
      'covered',
    ]);
    expect(isManual('manual 1d, review 6b')).toBe(true);
    expect(isManual('manual 1d, repeated 6b')).toBe(true);
    expect(isManual('CI + manual 0a')).toBe(false);
    expect(isManual('CI + manual 0a', '', true)).toBe(true);
    expect(isManual('CI + unit', '', true)).toBe(false);
    expect(isManual('integration, repeated 6b')).toBe(false);
    expect(isManual('n/a')).toBe(true);
    expect(isManual('`npm run screenshots`')).toBe(true);
    expect(isManual('integration')).toBe(false);
  });

  it('exits nonzero when any row is MISSING and zero when none is', () => {
    const rows = parseAcTables(TABLE, 'docs/spec/99-fixture.md');
    const lines: string[] = [];
    const missing = classify(rows, new Map([['AC-AAA-01', ['a']]]));
    expect(report(missing, (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain('1 MISSING');
    expect(lines.join('\n')).toContain('AC-AAA-04 (docs/spec/99-fixture.md:10) integration');

    const allManual = classify(
      rows,
      new Map([
        ['AC-AAA-01', ['a']],
        ['AC-AAA-04', ['b']],
      ]),
    );
    expect(report(allManual, () => {})).toBe(0);
  });

  it('splits a mixed proved-by cell: manual only when every part is manual', () => {
    const mixed = parseAcTables(
      '| ID | Criterion | Rules | Proved by |\n|---|---|---|---|\n' +
        '| AC-MIX-01 | x | R | unit + manual 6b |\n' +
        '| AC-MIX-02 | x | R | manual; review 6a |\n' +
        '| AC-MIX-03 | x | R | integration, owner step |\n',
    );
    expect(automatedSegments('unit + manual 6b')).toEqual(['unit']);
    expect(classify(mixed, new Map()).map((result) => result.status)).toEqual([
      'MISSING',
      'manual',
      'MISSING',
    ]);
    expect(classify(mixed, new Map([['AC-MIX-01', ['a']]]))[0]?.status).toBe('covered');
  });

  it('ignores skipped, todo, failing and commented-out titles', () => {
    const covered = coveredAcIds([
      {
        file: 'tests/unit/h.test.ts',
        text: [
          "it.skip('AC-SKP-01 skipped', () => {});",
          "it.todo('AC-SKP-02 todo');",
          "test.skip('AC-SKP-03 skipped', () => {});",
          "describe.skip('AC-SKP-04 skipped', () => {});",
          "it.fails('AC-SKP-05 fails', () => {});",
          "// it('AC-SKP-06 commented', () => {});",
          " * it('AC-SKP-07 in a block comment', () => {});",
          "it('AC-SKP-08 real', () => {});",
        ].join('\n'),
      },
    ]);
    expect([...covered.keys()]).toEqual(['AC-SKP-08']);
  });

  it('fails when the spec has AC lines the parser did not read', () => {
    expect(countAcLines(TABLE)).toBe(5);
    expect(() => assertAllRowsParsed(5, 4)).toThrow(/5 AC lines.*4 rows/);
    expect(() => assertAllRowsParsed(4, 4)).not.toThrow();
  });
});
