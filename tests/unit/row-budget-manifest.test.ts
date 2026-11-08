import { describe, expect, it } from 'vitest';
import { key, unique } from '../fixtures/route-manifest';
import { budgets, excluded } from '../fixtures/row-budgets';

// AC-BUD-02: a new GET route cannot slip past the row-read budget unnoticed. The
// integration suite measures the entries; this one proves every manifest route is one
// of them or carries a written reason it cannot be.

const getRoutes = unique.filter((route) => route.method === 'GET').map(key);

describe('AC-BUD-02 row-read budget coverage', () => {
  it('every manifest GET route is measured or explicitly excluded', () => {
    const missing = getRoutes.filter(
      (route) => !budgets.some((entry) => entry.route === route) && !(route in excluded),
    );
    expect(missing).toEqual([]);
  });

  it('every budget and exclusion names a real manifest GET route, once', () => {
    const measured = budgets.map((entry) => entry.route);
    expect(new Set(measured).size).toBe(measured.length);
    for (const route of [...measured, ...Object.keys(excluded)]) {
      expect(getRoutes, route).toContain(route);
    }
  });

  it('every exclusion carries a reason', () => {
    for (const [route, reason] of Object.entries(excluded)) {
      expect(reason.trim(), route).not.toBe('');
    }
  });
});
