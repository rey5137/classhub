import { describe, expect, it, vi } from 'vitest';
import {
  createCloudflarePushTransport,
  deliverPushBatch,
  PUSH_BATCH_SIZE,
  type PushServiceBinding,
} from '../../src/lib/server/adapters/cloudflare/push-transport';
import type { PushDeliveryRequest } from '../../src/lib/server/ports/push-transport';

function makeDeliveries(count: number): PushDeliveryRequest[] {
  return Array.from({ length: count }, (_, idx) => ({
    subscriptionId: `sub-${idx + 1}`,
    endpoint: `https://fcm.googleapis.com/fcm/send/token-${idx + 1}`,
    headers: { Authorization: 'vapid t=a.b.c, k=pub', TTL: '3600' },
    body: new Uint8Array([1, 2, 3]),
  }));
}

describe('Web Push fan-out batching (R-NTF-05)', () => {
  it('AC-NTF-08 sends 120 deliveries to PushDelivery as 3 batches of <= 40, and no batch makes more than 40 fetches', async () => {
    const batchesSeen: number[] = [];
    const fetchCountsPerBatch: number[] = [];

    const stubBinding: PushServiceBinding = {
      async deliver(batch) {
        batchesSeen.push(batch.length);
        let fetchesInThisInvocation = 0;
        const fakeFetch = vi.fn(async () => {
          fetchesInThisInvocation++;
          return new Response(null, { status: 201 });
        }) as unknown as typeof fetch;
        const result = await deliverPushBatch(batch, fakeFetch);
        fetchCountsPerBatch.push(fetchesInThisInvocation);
        return result;
      },
    };

    const transport = createCloudflarePushTransport(stubBinding);
    const deliveries = makeDeliveries(120);
    const results = await transport.send(deliveries);

    expect(batchesSeen).toEqual([40, 40, 40]);
    expect(fetchCountsPerBatch).toEqual([40, 40, 40]);
    expect(Math.max(...fetchCountsPerBatch)).toBeLessThanOrEqual(PUSH_BATCH_SIZE);
    expect(results).toHaveLength(120);
    expect(results[0]).toEqual({ subscriptionId: 'sub-1', status: 201 });
    expect(results[119]).toEqual({ subscriptionId: 'sub-120', status: 201 });

    // Even if deliverPushBatch is handed > 40 directly, it caps at 40 fetches.
    let directFetches = 0;
    const directResult = await deliverPushBatch(makeDeliveries(55), (async () => {
      directFetches++;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch);
    expect(directFetches).toBe(40);
    expect(directResult).toHaveLength(40);
  });
});
