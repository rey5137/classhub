import { describe, expect, it, vi } from 'vitest';
import {
  createCloudflarePushTransport,
  deliverPushBatch,
  resolvePushTransport,
  PUSH_BATCH_SIZE,
  type PushServiceBinding,
} from '../../src/lib/server/adapters/cloudflare/push-transport';
import type { PushDeliveryRequest } from '../../src/lib/server/ports/push-transport';

const VALID_P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const VALID_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

function makeDeliveries(count: number): PushDeliveryRequest[] {
  return Array.from({ length: count }, (_, idx) => ({
    subscriptionId: `sub-${idx + 1}`,
    endpoint: `https://fcm.googleapis.com/fcm/send/token-${idx + 1}`,
    p256dh: VALID_P256DH,
    auth: VALID_AUTH,
    payload: JSON.stringify({ title: 'T', body: 'B', tag: 'chat' }),
    headers: { Authorization: 'vapid t=a.b.c, k=pub', TTL: '3600' },
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

  it('R-NTF-05 deliver encrypts the plaintext payload per subscription, and unusable keys answer 400 without a fetch', async () => {
    const sent: { body: unknown; headers: unknown }[] = [];
    const fakeFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push({ body: init?.body, headers: init?.headers });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const [good, bad] = makeDeliveries(2) as [PushDeliveryRequest, PushDeliveryRequest];
    bad.p256dh = 'malformed-key';
    const results = await deliverPushBatch([good, bad], fakeFetch);
    expect(results).toEqual([
      { subscriptionId: 'sub-1', status: 201 },
      { subscriptionId: 'sub-2', status: 400 },
    ]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const body = sent[0]!.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(body)).not.toContain('"title"');
    expect(sent[0]!.headers).toEqual(good.headers);
  });

  it('R-NTF-05 a batch whose RPC throws is logged by class only, and the other batches still report', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
    try {
      let call = 0;
      const transport = createCloudflarePushTransport({
        async deliver(batch) {
          call += 1;
          if (call === 2) throw new TypeError('https://fcm.googleapis.com/fcm/send/secret');
          return batch.map((item) => ({ subscriptionId: item.subscriptionId, status: 201 }));
        },
      });
      const results = await transport.send(makeDeliveries(85));
      expect(results).toHaveLength(45);
      expect(lines.filter((l) => l.includes('"pushError":"deliver"'))).toEqual([
        '{"pushError":"deliver","errorClass":"TypeError"}',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('R-NTF-05 without the PUSH binding a production transport is unavailable and logs one config line; dev delivers in-process', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
    try {
      expect(resolvePushTransport(undefined, false)).toBeUndefined();
      expect(resolvePushTransport(undefined, false)).toBeUndefined();
      expect(lines).toEqual(['{"config":"push_binding_unavailable"}']);
      expect(resolvePushTransport({ deliver: async () => [] }, false)).toBeDefined();
      expect(resolvePushTransport(undefined, true)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});
