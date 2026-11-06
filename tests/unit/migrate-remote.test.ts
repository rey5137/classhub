import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrateRemote } from '../../scripts/db-migrate-remote.mjs';
import { runSetup, SetupError } from '../../scripts/lib/setup.mjs';
import { createSandbox, type Sandbox } from '../fixtures/script-sandbox';

// AC-OPS-06 / INV-7: db:migrate:remote applies nothing until a verified backup is newer than
// the last deploy. Real setup against the in-process fakes, then the gate.

const deployedAt = Date.parse('2026-11-01T00:00:00.000Z');
const destructive = '0099_drop_x_destructive.sql';
let box: Sandbox;
let lines: string[];

const setup = () =>
  runSetup({
    run: box.runner,
    ask: async ({ key, fallback }) => (key === 'admin' ? 'admin@example.test' : fallback),
    out: () => {},
    root: box.dir,
    nodeVersion: '24.0.0',
    uuid: () => crypto.randomUUID(),
    secret: () => 'secret-value',
  });
const migrate = () =>
  runMigrateRemote({
    run: box.runner,
    root: box.dir,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
const sql = (statement: string) => {
  const db = box.d1();
  db.prepare(statement).run();
  db.close();
};
const applied = () => {
  const db = box.d1();
  const names = db.prepare('select name from d1_migrations order by id').pluck().all();
  db.close();
  return names;
};
const backupAt = (at: number) =>
  sql(
    `insert into backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) values ('b${at}', 'full', 'x', 0, 0, ${at})`,
  );
const deployed = (...times: number[]) =>
  box.writeState({
    ...box.readState(),
    deployments: times.map((time, index) => ({
      id: `d${index}`,
      created_on: new Date(time).toISOString(),
    })),
  });
const addDestructive = () =>
  writeFileSync(
    join(box.dir, 'migrations', destructive),
    'create table dropped_later (id text);\n',
  );

beforeEach(async () => {
  box = await createSandbox();
  lines = [];
  await setup();
  addDestructive();
});
afterEach(() => box.close());

describe('npm run db:migrate:remote', () => {
  it('AC-OPS-06 refuses without a verified backup', async () => {
    deployed(deployedAt);
    expect(await migrate()).toBe(1);
    expect(lines.join('\n')).toContain('refused: no verified backup exists.');
    expect(lines.join('\n')).toContain('npm run backup');
    expect(applied()).not.toContain(destructive);
  });

  it('AC-OPS-06 refuses when the newest verified backup is older than the last deploy', async () => {
    // The newest of several deployments counts, in any order.
    deployed(deployedAt, deployedAt - 86_400_000);
    backupAt(deployedAt - 1_000);
    sql(
      `insert into backup_runs (id, kind, manifest_sha256, object_count, total_bytes, verified_at) values ('unverified', 'full', 'x', 0, 0, null)`,
    );
    expect(await migrate()).toBe(1);
    expect(lines.join('\n')).toContain(
      'is not newer than the last deploy (2026-11-01T00:00:00.000Z)',
    );
    expect(applied()).not.toContain(destructive);
  });

  it.each([
    ['the CLI fails', { failures: { 'deployments list': 'Authentication error' } }],
    ['created_on is not a time', { deployments: [{ id: 'd', created_on: 'yesterday' }] }],
  ])('AC-OPS-06 refuses when the last deploy time is unreadable: %s', async (_case, state) => {
    backupAt(deployedAt + 1_000);
    box.writeState({ ...box.readState(), ...state });
    expect(await migrate()).toBe(1);
    expect(lines.join('\n')).toContain('cannot read the last deploy time');
    expect(applied()).not.toContain(destructive);
  });

  it('AC-OPS-06 applies, naming the destructive step, once a verified backup is newer', async () => {
    deployed(deployedAt);
    backupAt(deployedAt - 5_000);
    backupAt(deployedAt + 1_000);
    expect(await migrate()).toBe(0);
    expect(lines).toContain(`db:migrate:remote: DESTRUCTIVE ${destructive}`);
    expect(applied()).toContain(destructive);
    // A rerun with nothing pending is a no-op that still passes the gate.
    lines = [];
    expect(await migrate()).toBe(0);
    expect(lines.at(-1)).toBe('db:migrate:remote: no pending migrations.');
  });

  it('AC-OPS-06 after setup, the Worker upload setup made is the last deploy to beat', async () => {
    // Setup's `secret put` created the Worker; the deployment list holds that upload.
    const uploadedAt = Date.parse(box.readState().workerCreatedAt!);
    expect(Number.isFinite(uploadedAt)).toBe(true);
    backupAt(uploadedAt - 1);
    expect(await migrate()).toBe(1);
    expect(lines.join('\n')).toContain('is not newer than the last deploy');
    expect(applied()).not.toContain(destructive);
    lines = [];
    backupAt(uploadedAt + 1);
    expect(await migrate()).toBe(0);
    expect(applied()).toContain(destructive);
  });

  it("AC-OPS-06 before the Worker's first upload (wrangler: Worker does not exist) needs only a verified backup", async () => {
    // Setup by hand can migrate D1 before anything creates the Worker (R-OPS-05).
    box.writeState({ ...box.readState(), worker: false });
    expect(await migrate()).toBe(1);
    expect(lines.join('\n')).toContain('refused: no verified backup exists.');
    lines = [];
    backupAt(1);
    expect(await migrate()).toBe(0);
    expect(lines[0]).toContain('newer than the last deploy (none yet)');
    expect(applied()).toContain(destructive);
  });

  it('AC-OPS-06 an empty deployment list also counts as never deployed', async () => {
    deployed();
    backupAt(1);
    expect(await migrate()).toBe(0);
  });
});

describe('npm run setup and destructive migrations', () => {
  it('INV-7 a rerun of setup refuses to apply a pending destructive migration', async () => {
    await expect(setup()).rejects.toThrow(SetupError);
    await expect(setup()).rejects.toThrow(/destructive; setup never applies it/);
    expect(applied()).not.toContain(destructive);
  });

  it('INV-7 a first setup on a new, empty database applies every migration', async () => {
    await box.close();
    box = await createSandbox();
    addDestructive();
    await setup();
    expect(applied()).toContain(destructive);
  });
});
