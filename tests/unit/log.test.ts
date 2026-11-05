import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('log hashing', () => {
  it('R-AUTH-23 uses LOG_HASH_SALT when set, so hashes match across isolates', async () => {
    const { resolveLogSalt, saltedHash } = await import('../../src/lib/server/log');
    const salt = resolveLogSalt('configured-salt', true);
    expect(salt).toBe('configured-salt');
    const hash = await saltedHash(salt, 'member-id');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await saltedHash('configured-salt', 'member-id')).toBe(hash);
    expect(await saltedHash('other-salt', 'member-id')).not.toBe(hash);
  });

  it('R-AUTH-23 falls back to one random salt per isolate', async () => {
    const { resolveLogSalt } = await import('../../src/lib/server/log');
    const first = resolveLogSalt(undefined, false);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveLogSalt(undefined, false)).toBe(first);
    vi.resetModules();
    const fresh = await import('../../src/lib/server/log');
    expect(fresh.resolveLogSalt(undefined, false)).not.toBe(first);
  });

  it('R-AUTH-23 a production build warns once, without a value, when the secret is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveLogSalt } = await import('../../src/lib/server/log');
    resolveLogSalt(undefined, true);
    resolveLogSalt(undefined, true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('{"level":"warn","config":"LOG_HASH_SALT is not set"}');
    resolveLogSalt(undefined, false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a dev build does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveLogSalt } = await import('../../src/lib/server/log');
    resolveLogSalt(undefined, false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('redact masks emails, JWTs and phone numbers', async () => {
    const { redact } = await import('../../src/lib/server/log');
    expect(redact('a.b@example.test eyJx.eyJy.z +84 912 345 678 ok')).toBe(
      '[email] [jwt] [number] ok',
    );
  });
});
