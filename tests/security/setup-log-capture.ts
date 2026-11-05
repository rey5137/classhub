import { afterAll, beforeAll, expect } from 'vitest';
import { FIXTURE_PHONE } from '../fixtures/membership';

// AC-AUTH-12: every console line of the security run is captured (and kept off
// the test output); none may carry an email, a phone number, a message body or a JWT.

export const FIXTURE_BODY = 'A secret note from the reunion dinner';
export const captured: string[] = [];
const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const originals = new Map<string, (...args: unknown[]) => void>();

export function forbiddenInLogs(line: string): string | null {
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(line)) return 'an email';
  if (line.includes(FIXTURE_PHONE) || line.includes(FIXTURE_PHONE.replace(/\s/g, '')))
    return 'a phone';
  if (line.includes(FIXTURE_BODY)) return 'a message body';
  if (/eyJ[\w-]+\.[\w-]+\./.test(line)) return 'a JWT';
  return null;
}

beforeAll(() => {
  for (const method of methods) {
    originals.set(method, console[method]);
    console[method] = (...args: unknown[]) => {
      captured.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
    };
  }
});

afterAll(() => {
  for (const method of methods) console[method] = originals.get(method)!;
  const leaks = captured.flatMap((line) => {
    const what = forbiddenInLogs(line);
    return what ? [`${what}: ${line.slice(0, 200)}`] : [];
  });
  captured.length = 0;
  expect(leaks).toEqual([]);
});
