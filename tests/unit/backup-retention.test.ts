import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEEP_MONTHLY,
  KEEP_WEEKLY,
  pruneOldSnapshots,
  snapshotsToPrune,
} from '../../scripts/lib/backup-retention.mjs';

const DAY = 86_400_000;
const nameAt = (time: number) =>
  `classhub-backup-${new Date(time).toISOString().replace(/:|\.\d{3}/g, '')}.tar.age`;
/** One snapshot every `step` days, newest first ending at `end`. */
const series = (end: string, count: number, step: number) =>
  Array.from({ length: count }, (_, index) => nameAt(Date.parse(end) - index * step * DAY));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'classhub-retention-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('R-BAK-11 snapshot retention', () => {
  it('R-BAK-11 keeps the newest of each of the last 12 weeks and 12 months, deletes the rest', () => {
    // Weekly on Thursdays for two years.
    const names = series('2026-11-05T00:00:00Z', 104, 7);
    const doomed = new Set(snapshotsToPrune(names));
    const kept = names.filter((name) => !doomed.has(name));
    // The 12 newest weekly ones, then one per older month back to 12 months in all.
    expect(kept.slice(0, KEEP_WEEKLY)).toEqual(names.slice(0, KEEP_WEEKLY));
    const months = new Set(kept.map((name) => name.slice(16, 23)));
    expect(months.size).toBe(KEEP_MONTHLY);
    expect([...months].at(-1)).toBe('2025-12');
    // 12 weekly cover Aug–Nov 2026 (4 months); 8 more monthly reach back to Dec 2025.
    expect(kept).toHaveLength(KEEP_WEEKLY + 8);
    expect(kept).toContain('classhub-backup-2025-12-25T000000Z.tar.age');
    expect(doomed.has('classhub-backup-2025-12-18T000000Z.tar.age')).toBe(true);
    expect(doomed.has(names[0]!)).toBe(false);
  });

  it('R-BAK-11 several snapshots in one week keep only the newest; a gap deletes nothing it needs', () => {
    const sameWeek = [
      'classhub-backup-2026-11-05T120000Z.tar.age',
      'classhub-backup-2026-11-03T000000Z.tar.age',
      'classhub-backup-2026-11-02T000000Z.tar.age', // Monday, same ISO week
    ];
    // A year without backups before that: those old weekly ones still count as weeks.
    const old = series('2025-06-26T00:00:00Z', 10, 7);
    const doomed = snapshotsToPrune([...sameWeek, ...old]);
    expect(doomed.sort()).toEqual(sameWeek.slice(1).sort());
  });

  it('R-BAK-11 ISO weeks: a Sunday and the Monday after are different weeks across a year end', () => {
    const names = [
      'classhub-backup-2027-01-04T000000Z.tar.age', // Monday, 2027-W01
      'classhub-backup-2027-01-03T000000Z.tar.age', // Sunday, 2026-W53
      'classhub-backup-2027-01-02T000000Z.tar.age', // Saturday, 2026-W53, same month
    ];
    expect(snapshotsToPrune(names)).toEqual(['classhub-backup-2027-01-02T000000Z.tar.age']);
  });

  it('R-BAK-11 never names a file that is not a finished snapshot', () => {
    const others = [
      '.classhub-backup-2020-01-01T000000Z.tar.age.partial',
      'classhub-backup-2020-13-40T000000Z.tar.age',
      'classhub-backup-2020-01-01T000000Z.tar',
      'chat-2020.ndjson.age',
      'notes.txt',
    ];
    const names = [...series('2026-11-05T00:00:00Z', 60, 7), ...others];
    const doomed = snapshotsToPrune(names);
    expect(doomed.length).toBeGreaterThan(0);
    for (const other of others) expect(doomed).not.toContain(other);
  });

  it('R-BAK-11 pruneOldSnapshots deletes only regular files, never a link or a directory', () => {
    const names = series('2026-11-05T00:00:00Z', 30, 7);
    for (const name of names.slice(0, 28)) writeFileSync(join(dir, name), 'archive');
    // The two oldest names: one a directory, one a link to a file outside.
    mkdirSync(join(dir, names[28]!));
    writeFileSync(join(dir, '..', 'classhub-retention-target'), 'outside');
    symlinkSync(join(dir, '..', 'classhub-retention-target'), join(dir, names[29]!));
    try {
      const { deleted, failed } = pruneOldSnapshots(dir);
      expect(failed).toEqual([]);
      expect(deleted.length).toBeGreaterThan(0);
      const left = new Set(readdirSync(dir));
      for (const name of deleted) expect(left.has(name)).toBe(false);
      expect(left.has(names[0]!)).toBe(true);
      expect(left.has(names[28]!)).toBe(true);
      expect(left.has(names[29]!)).toBe(true);
      expect(deleted).toEqual(snapshotsToPrune(names.slice(0, 28)));
    } finally {
      rmSync(join(dir, '..', 'classhub-retention-target'), { force: true });
    }
  });

  it('R-BAK-11 never prunes the archive this run wrote, even when a newer one shares its week', () => {
    // --out shared with another site: its 2026-11-06 snapshot is newer, in the same ISO week.
    const ours = nameAt(Date.parse('2026-11-05T00:00:00Z'));
    const other = nameAt(Date.parse('2026-11-06T00:00:00Z'));
    // Without the protection the week's newest would win and ours would go.
    expect(snapshotsToPrune([ours, other])).toEqual([ours]);
    expect(snapshotsToPrune([ours, other], ours)).toEqual([]);
    for (const name of [ours, other]) writeFileSync(join(dir, name), 'archive');
    expect(pruneOldSnapshots(dir, { protect: ours })).toEqual({ deleted: [], failed: [] });
    expect(readdirSync(dir).sort()).toEqual([ours, other]);
  });

  it('R-BAK-11 a delete that throws is reported and the remaining old snapshots still go', () => {
    const names = series('2026-11-05T00:00:00Z', 30, 7);
    for (const name of names) writeFileSync(join(dir, name), 'archive');
    const doomed = snapshotsToPrune(names);
    expect(doomed.length).toBeGreaterThan(2);
    const remove = (path: string) => {
      if (path.endsWith(doomed[0]!)) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      if (path.endsWith(doomed[1]!)) throw new Error('disk went away');
      rmSync(path);
    };
    const { deleted, failed } = pruneOldSnapshots(dir, { remove });
    expect(failed).toEqual([
      { name: doomed[0], reason: 'EPERM' },
      { name: doomed[1], reason: 'disk went away' },
    ]);
    expect(deleted).toEqual(doomed.slice(2));
    const left = new Set(readdirSync(dir));
    expect(left.has(doomed[0]!) && left.has(doomed[1]!)).toBe(true);
    for (const name of deleted) expect(left.has(name)).toBe(false);
  });
});
