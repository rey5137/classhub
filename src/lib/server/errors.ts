import type { ErrorBody, ErrorCode } from '../contracts/errors';
import { t, type Locale } from '../i18n';

const statusFor: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  locked: 423,
  not_found: 404,
  validation: 400,
  rate_limited: 429,
  storage_full: 507,
  feature_disabled: 404,
  conflict: 409,
  payload_too_large: 413,
  unavailable: 503,
  internal: 500,
};

export interface ApiErrorOptions {
  requestId: string;
  locale: Locale;
  /** Overrides the code's default status (415 for a wrong Content-Type, R-API-02). */
  status?: number;
  fields?: Record<string, string>;
  headers?: HeadersInit;
}

/** R-API-02: `{ error: { code, message, requestId } }`, with the id echoed in `X-Request-Id`. */
export function apiError(code: ErrorCode, options: ApiErrorOptions): Response {
  const body: ErrorBody = {
    error: {
      code,
      message: t(options.locale, `error.${code}`),
      requestId: options.requestId,
      ...(options.fields ? { fields: options.fields } : {}),
    },
  };
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-request-id', options.requestId);
  return new Response(JSON.stringify(body), { status: options.status ?? statusFor[code], headers });
}
