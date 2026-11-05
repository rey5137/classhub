import { describe, expect, it } from 'vitest';
import { normalizeName } from '../../src/lib/shared/normalize';

describe('normalizeName (R-PROF-08)', () => {
  it.each([
    ['Nguyễn Văn An', 'nguyen van an'],
    ['ĐẶNG Đức', 'dang duc'],
    ['đỗ thị hằng', 'do thi hang'],
    ['  Trần   Thị\tBích ', 'tran thi bich'],
    // Precomposed and decomposed forms fold the same.
    ['Nguyễn', 'nguyen'],
    ['Lê Ánh', 'le anh'],
  ])('folds %j to %j', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});
