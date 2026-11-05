import { describe, expect, it } from 'vitest';
import { errorBodySchema, errorCodes } from '../../src/lib/contracts/errors';
import { apiError } from '../../src/lib/server/errors';
import { t } from '../../src/lib/i18n';

describe('apiError', () => {
  it('R-API-02 returns { error: { code, message, requestId } } with X-Request-Id for every code', async () => {
    for (const code of errorCodes) {
      for (const locale of ['vi', 'en'] as const) {
        const response = apiError(code, { requestId: 'req-123', locale });
        const body = errorBodySchema.parse(await response.json());
        expect(body.error).toEqual({
          code,
          message: t(locale, `error.${code}`),
          requestId: 'req-123',
        });
        expect(response.headers.get('x-request-id')).toBe('req-123');
        expect(response.headers.get('content-type')).toBe('application/json');
      }
    }
  });

  it('R-API-02 maps the codes the spec fixes to their statuses', () => {
    const status = (code: (typeof errorCodes)[number]) =>
      apiError(code, { requestId: 'r', locale: 'en' }).status;
    expect(status('forbidden')).toBe(403);
    expect(status('locked')).toBe(423);
    expect(status('rate_limited')).toBe(429);
    expect(status('payload_too_large')).toBe(413);
    expect(status('validation')).toBe(400);
    expect(apiError('validation', { requestId: 'r', locale: 'en', status: 415 }).status).toBe(415);
  });

  it('carries validation fields', async () => {
    const response = apiError('validation', {
      requestId: 'r',
      locale: 'en',
      fields: { title: 'required' },
    });
    expect(((await response.json()) as { error: { fields: unknown } }).error.fields).toEqual({
      title: 'required',
    });
  });
});
