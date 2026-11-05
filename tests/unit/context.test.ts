import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IdentityError } from '../../src/lib/server/ports/identity';
import { createContext, type AppContext } from '../../src/lib/server/context';

let directory: string;
let context: AppContext;
const previous = {
  db: process.env.CLASSHUB_DB,
  objects: process.env.CLASSHUB_OBJECTS,
  member: process.env.CLASSHUB_DEV_MEMBER,
};

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'classhub-context-'));
  process.env.CLASSHUB_DB = join(directory, 'dev.sqlite');
  process.env.CLASSHUB_OBJECTS = join(directory, 'objects');
  process.env.CLASSHUB_DEV_MEMBER = 'admin@example.com';
  context = await createContext(undefined);
});

afterAll(() => {
  (context.database as unknown as { close?: () => void }).close?.();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of [
    ['CLASSHUB_DB', previous.db],
    ['CLASSHUB_OBJECTS', previous.objects],
    ['CLASSHUB_DEV_MEMBER', previous.member],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createContext', () => {
  it('R-PLAT-03 works outside SvelteKit and memoises one local context', async () => {
    expect(context.database).toBeDefined();
    expect(context.storage).toBeDefined();
    await expect(createContext(undefined)).resolves.toBe(context);
  });

  it('R-AUTH-13 carries the dev identity in the memoised context', async () => {
    await expect(
      context.identity.requireIdentity(new Request('http://127.0.0.1:5173/'), {
        clientAddress: '127.0.0.1',
      }),
    ).resolves.toEqual({ email: 'admin@example.com', subject: 'dev:admin@example.com' });
  });

  describe('adapter selection with a platform binding (R-PLAT-10)', () => {
    const platform = { env: { DB: {}, MEDIA: {} } } as unknown as App.Platform;
    const previousOffline = process.env.CLASSHUB_OFFLINE;
    afterEach(() => {
      if (previousOffline === undefined) delete process.env.CLASSHUB_OFFLINE;
      else process.env.CLASSHUB_OFFLINE = previousOffline;
    });

    it('R-PLAT-10 CLASSHUB_OFFLINE=1 picks the local adapters despite env.DB', async () => {
      process.env.CLASSHUB_OFFLINE = '1';
      await expect(createContext(platform)).resolves.toBe(context);
    });

    it('R-PLAT-10 without CLASSHUB_OFFLINE the Cloudflare adapters are used', async () => {
      delete process.env.CLASSHUB_OFFLINE;
      const cloudflare = await createContext(platform);
      expect(cloudflare).not.toBe(context);
    });

    it('R-AUTH-13 the Cloudflare context identity always throws IdentityError', async () => {
      delete process.env.CLASSHUB_OFFLINE;
      const cloudflare = await createContext(platform);
      await expect(
        cloudflare.identity.requireIdentity(new Request('https://classhub.example.com/'), {
          clientAddress: '127.0.0.1',
        }),
      ).rejects.toBeInstanceOf(IdentityError);
    });
  });
});
