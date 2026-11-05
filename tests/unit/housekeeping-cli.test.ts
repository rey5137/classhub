import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { housekeepingDependencies } from '../../scripts/housekeeping.mjs';
import type { runCf } from '../../scripts/lib/cf-child.mjs';
import { createS3Client } from '../../scripts/lib/s3.mjs';
import { createRemoteDatabase } from '../../src/lib/server/adapters/cloudflare/remote-database';
import { schemaMeta } from '../../src/lib/server/db/schema';

const credentials = {
  account: 'a'.repeat(32),
  bucket: 'classhub-media',
  accessKey: 'test-access',
  secretKey: 'synthetic-secret',
};
const now = () => new Date('2026-01-02T03:04:05.000Z');
const listing = (contents = '', tail = '<IsTruncated>false</IsTruncated>') =>
  `<ListBucketResult><KeyCount>${[...contents.matchAll(/<Contents>/g)].length}</KeyCount>${contents}${tail}</ListBucketResult>`;
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('housekeeping CLI transports', () => {
  it('AC-MEM-09 signs bounded S3 listings, preserves cursors and decodes object keys', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          listing(
            '<Contents><Key>media%2Fv1%2Fa%20b.webp</Key><Size>42</Size></Contents>',
            '<IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken>',
          ),
        ),
      );
    const client = createS3Client(credentials, { fetch: fetcher, now });
    expect(await client.list('media/', 'old+/=')).toEqual({
      objects: [{ key: 'media/v1/a b.webp', size: 42 }],
      cursor: 'a&b',
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain(
      'continuation-token=old%2B%2F%3D&encoding-type=url&list-type=2&max-keys=100&prefix=media%2F',
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({
      'x-amz-date': '20260102T030405Z',
      authorization: expect.stringMatching(
        /^AWS4-HMAC-SHA256 Credential=test-access\/20260102\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/,
      ),
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(credentials.secretKey);
  });

  it('AC-MEM-09 deletes idempotently with encoded keys and propagates storage failures', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const client = createS3Client(credentials, { fetch: fetcher, now });
    await client.delete(['staging/v1/a b/image.webp']);
    await client.delete(['staging/v1/a b/image.webp']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toContain('/classhub-media/staging/v1/a%20b/image.webp');
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE');
    await expect(client.delete(['outside/key'])).rejects.toThrow('Invalid media');
    await expect(client.delete(['media/../outside'])).rejects.toThrow('Invalid media');
    fetcher.mockResolvedValueOnce(new Response('untrusted error', { status: 403 }));
    await expect(client.delete(['media/a'])).rejects.toThrow('HTTP 403');
    fetcher.mockRejectedValueOnce(new Error('timeout'));
    await expect(client.list('media/')).rejects.toThrow('timeout');
  });

  it.each([
    'broken',
    listing('<Contents><Key>media/a</Key><Size>-1</Size></Contents>'),
    listing('', '<IsTruncated>true</IsTruncated>'),
    'x'.repeat(1_048_577),
  ])('AC-MEM-09 refuses invalid or oversized bucket listings', async (xml) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(xml));
    await expect(
      createS3Client(credentials, { fetch: fetcher, now }).list('media/'),
    ).rejects.toThrow();
  });

  it('AC-MEM-09 preserves raw duplicate-column positions and refuses non-atomic REST batches', async () => {
    const request = vi.fn(async () => [
      {
        success: true,
        results: { columns: ['value', 'value'], rows: [['first', 'second']] },
        meta: { changes: 0 },
      },
    ]);
    const database = createRemoteDatabase(request);
    expect(
      await database.db
        .select({ first: schemaMeta.value, second: schemaMeta.value })
        .from(schemaMeta)
        .limit(1),
    ).toEqual([{ first: 'first', second: 'second' }]);
    expect(request.mock.calls[0]).toHaveLength(1);
    const query = database.db
      .update(schemaMeta)
      .set({ value: 'one' })
      .where(eq(schemaMeta.key, 'first'));
    await expect(database.batch([query])).rejects.toThrow('atomic batches');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('AC-MEM-09 guards the account before returning CLI transports and keeps SQL out of argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classhub-housekeeping-'));
    directories.push(dir);
    const config = {
      account_id: credentials.account,
      d1_databases: [{ binding: 'DB', database_id: '11111111-1111-4111-8111-111111111111' }],
      r2_buckets: [{ binding: 'MEDIA', bucket_name: credentials.bucket }],
    };
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify(config));
    writeFileSync(
      join(dir, '.env.cloudflare'),
      `CLOUDFLARE_ACCOUNT_ID=${credentials.account}\nR2_HOUSEKEEPING_ACCESS_KEY_ID=test-access\nR2_HOUSEKEEPING_SECRET_ACCESS_KEY=synthetic-secret\n`,
    );
    const run = vi.fn<typeof runCf>(() => ({ status: 0, stdout: '{}', stderr: '' }));
    const deps = housekeepingDependencies(dir, run);
    expect(run.mock.calls[0]).toEqual([
      ['api', '/r2/buckets/classhub-media'],
      { input: undefined },
    ]);
    run.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify([
        { success: true, results: { columns: ['value'], rows: [['0']] }, meta: { changes: 0 } },
      ]),
      stderr: '',
    });
    await deps.database.db.select({ value: schemaMeta.value }).from(schemaMeta).limit(1);
    expect(run.mock.calls[1][0]).toEqual(['d1-query', '11111111-1111-4111-8111-111111111111']);
    expect(run.mock.calls[1][1]?.input).toContain('select');
    expect(JSON.stringify(run.mock.calls)).not.toContain('synthetic-secret');
    run.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'blocked' });
    expect(() => housekeepingDependencies(dir, run)).toThrow('Guarded Cloudflare');
    writeFileSync(
      join(dir, 'wrangler.jsonc'),
      JSON.stringify({ ...config, account_id: 'b'.repeat(32) }),
    );
    expect(() => housekeepingDependencies(dir, run)).toThrow('account mismatch');
  });
});
