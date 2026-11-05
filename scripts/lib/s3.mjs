import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

const credentialsSchema = z.object({
  account: z.string().regex(/^[0-9a-f]{32}$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
});
const objectSchema = z.object({
  key: z.string().min(1),
  size: z.number().int().nonnegative().safe(),
});
/** @param {string} value */
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
/** @param {string} value */
const hash = (value) => createHash('sha256').update(value).digest('hex');
/** @param {string | Buffer} key @param {string} value */
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
/** @param {string} value */
const unescapeXml = (value) =>
  value.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity] ?? entity,
  );

/** Minimal R-BAK-17 shared S3 client: housekeeping needs only list and delete. */
export function createS3Client(
  /** @type {z.input<typeof credentialsSchema>} */ credentials,
  /** @type {{ fetch?: typeof fetch; now?: () => Date }} */ options = {},
) {
  const { account, bucket, accessKey, secretKey } = credentialsSchema.parse(credentials);
  const host = `${account}.r2.cloudflarestorage.com`;
  const fetcher = options.fetch ?? fetch;
  /** @param {string} method @param {string} key @param {Record<string, string>} query */
  async function request(method, key, query) {
    const date = (options.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const path = `/${bucket}${key ? `/${key.split('/').map(encode).join('/')}` : ''}`;
    const search = Object.entries(query)
      .map(([key, value]) => [encode(key), encode(value)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const headers = { host, 'x-amz-content-sha256': hash(''), 'x-amz-date': date };
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = Object.entries(headers)
      .map(([key, value]) => `${key}:${value}\n`)
      .join('');
    const canonical = [method, path, search, canonicalHeaders, signedHeaders, hash('')].join('\n');
    const scope = `${day}/auto/s3/aws4_request`;
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretKey}`, day), 'auto'), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey)
      .update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`)
      .digest('hex');
    const response = await fetcher(`https://${host}${path}${search ? `?${search}` : ''}`, {
      method,
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`S3 ${method} failed: HTTP ${response.status}`);
    }
    return response;
  }
  return {
    /** @param {string} prefix @param {string} [cursor] */
    async list(prefix, cursor) {
      const response = await request('GET', '', {
        'list-type': '2',
        'max-keys': '100',
        'encoding-type': 'url',
        prefix,
        ...(cursor ? { 'continuation-token': cursor } : {}),
      });
      // A 100-key page is small; refuse a broken or hostile response before buffering it.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty S3 listing');
      const chunks = [];
      let size = 0;
      try {
        for (let reads = 0; ; reads++) {
          if (reads >= 10_000) throw new Error('S3 response read limit exceeded');
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) throw new Error('S3 listing exceeds response limit');
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel();
        throw error;
      } finally {
        reader.releaseLock();
      }
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      if (!/<ListBucketResult(?:\s[^>]*)?>/.test(xml) || !xml.includes('</ListBucketResult>'))
        throw new Error('Invalid S3 listing');
      const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, content]) => {
        const key = content.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        const size = content.match(/<Size>(\d+)<\/Size>/)?.[1];
        return objectSchema.parse({
          key: key === undefined ? undefined : decodeURIComponent(unescapeXml(key)),
          size: size === undefined ? NaN : Number(size),
        });
      });
      const truncated = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/)?.[1];
      const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
      const keyCount = xml.match(/<KeyCount>(\d+)<\/KeyCount>/)?.[1];
      if (
        keyCount === undefined ||
        Number(keyCount) !== objects.length ||
        !truncated ||
        (truncated === 'true' && !next) ||
        objects.length > 100
      )
        throw new Error('Incomplete S3 listing');
      return { objects, ...(truncated === 'true' ? { cursor: unescapeXml(next ?? '') } : {}) };
    },
    /** @param {string[]} keys */
    async delete(keys) {
      for (const key of keys) {
        if (
          !key ||
          !/^(?:media|avatars|staging)\//.test(key) ||
          key.split('/').some((part) => part === '.' || part === '..')
        )
          throw new Error('Invalid media object key');
        const response = await request('DELETE', key, {});
        await response.body?.cancel();
      }
    },
  };
}
