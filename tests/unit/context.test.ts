import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      context.identity!.requireIdentity(new Request('http://127.0.0.1:5173/')),
    ).resolves.toEqual({ email: 'admin@example.com', subject: 'dev:admin@example.com' });
  });
});
