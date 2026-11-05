import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Timestamp } from '../../src/lib/server/ids';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('R-DB-01 generates version 7 UUIDs with the expected variant', () => {
    expect(uuidv7()).toMatch(UUIDV7);
  });

  it('R-DB-01 keeps ids created in the same millisecond strictly ordered', () => {
    const ids = Array.from({ length: 1_000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('R-DB-01 encodes the requested millisecond', () => {
    const now = Date.now() + 60_000;
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
    expect(uuidv7Timestamp('not-a-uuid')).toBeNull();
  });
});
