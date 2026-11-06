import type {
  PushDeliveryRequest,
  PushDeliveryResult,
  PushTransport,
} from '../../ports/push-transport';
import { isAllowedPushEndpoint } from '../../push/allow-list';

// R-NTF-05: Workers Free caps external subrequests at 50 per invocation.
// Each batch of <= 40 runs in its own `PushDelivery` invocation via the `PUSH` binding.
export const PUSH_BATCH_SIZE = 40;
export const MAX_PUSH_BATCHES = 7;
const PUSH_FETCH_TIMEOUT_MS = 10_000;

export interface PushServiceBinding {
  deliver(batch: PushDeliveryRequest[]): Promise<PushDeliveryResult[]>;
}

/** Executes a single batch of <= 40 encrypted Web Push deliveries. */
export async function deliverPushBatch(
  batch: PushDeliveryRequest[],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<PushDeliveryResult[]> {
  const capped = batch.slice(0, PUSH_BATCH_SIZE);
  return Promise.all(
    capped.map(async (item): Promise<PushDeliveryResult> => {
      if (!isAllowedPushEndpoint(item.endpoint)) {
        return { subscriptionId: item.subscriptionId, status: 400 };
      }
      try {
        const response = await fetchFn(item.endpoint, {
          method: 'POST',
          headers: item.headers,
          body: item.body as BodyInit,
          redirect: 'manual',
          signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT_MS),
        });
        return { subscriptionId: item.subscriptionId, status: response.status };
      } catch {
        return { subscriptionId: item.subscriptionId, status: 'network_error' };
      }
    }),
  );
}

/** Splits deliveries into batches of at most 40 (at most 7 batches = 280 deliveries). */
export function splitPushBatches(deliveries: PushDeliveryRequest[]): PushDeliveryRequest[][] {
  const capped = deliveries.slice(0, PUSH_BATCH_SIZE * MAX_PUSH_BATCHES);
  const batches: PushDeliveryRequest[][] = [];
  for (let i = 0; i < capped.length; i += PUSH_BATCH_SIZE) {
    batches.push(capped.slice(i, i + PUSH_BATCH_SIZE));
  }
  return batches;
}

export function createCloudflarePushTransport(
  binding: PushServiceBinding | undefined,
): PushTransport {
  return {
    async send(deliveries) {
      if (deliveries.length === 0) return [];
      const batches = splitPushBatches(deliveries);
      if (!binding) {
        // Fallback when no PUSH self-binding is configured (local dev or test environments).
        const results = await Promise.all(batches.map((batch) => deliverPushBatch(batch)));
        return results.flat();
      }
      const results = await Promise.all(batches.map((batch) => binding.deliver(batch)));
      return results.flat();
    },
  };
}
