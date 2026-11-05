import { describe, expect, it } from 'vitest';
import { GET } from '../../src/routes/health/+server';

describe('GET /health', () => {
  it('AC-API-03 AC-PLAT-04 returns only ok and version', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['ok', 'version']);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });
});
