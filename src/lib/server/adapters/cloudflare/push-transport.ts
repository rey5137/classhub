import {
  MAX_PUSH_BATCHES,
  PUSH_BATCH_SIZE,
  type PushDeliveryRequest,
  type PushDeliveryResult,
  type PushTransport,
} from '../../ports/push-transport';
import { deliverPushRequest } from '../../push/deliver';
import { logLine } from '../../log';

// R-NTF-05: Workers Free caps external subrequests at 50 per invocation.
// Each batch of <= 40 runs in its own `PushDelivery` invocation via the `PUSH` binding.
export { MAX_PUSH_BATCHES, PUSH_BATCH_SIZE };

export interface PushServiceBinding {
  deliver(batch: PushDeliveryRequest[]): Promise<PushDeliveryResult[]>;
}

/** Encrypts and sends a single batch of <= 40 Web Push deliveries (one invocation's CPU and subrequests). */
export async function deliverPushBatch(
  batch: PushDeliveryRequest[],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<PushDeliveryResult[]> {
  return Promise.all(
    batch.slice(0, PUSH_BATCH_SIZE).map((item) => deliverPushRequest(item, fetchFn)),
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

export function createCloudflarePushTransport(binding: PushServiceBinding): PushTransport {
  return {
    async send(deliveries) {
      if (deliveries.length === 0) return [];
      const batches = splitPushBatches(deliveries);
      // A batch whose RPC fails loses only its own results; the other batches still count (R-NTF-06).
      const settled = await Promise.allSettled(batches.map((batch) => binding.deliver(batch)));
      return settled.flatMap((result) => {
        if (result.status === 'fulfilled') return result.value;
        const reason: unknown = result.reason;
        logLine({
          pushError: 'deliver',
          errorClass: reason instanceof Error ? reason.name : 'unknown',
        });
        return [];
      });
    },
  };
}

let loggedMissingPushBinding = false;

/**
 * R-NTF-05, R-OPS-10: the transport for a Worker or Durable Object env. Without the `PUSH`
 * self-binding a production build has no transport (push unavailable, one `config` line): a
 * single invocation cannot deliver past the subrequest cap. Dev builds deliver in-process.
 * `isDev` has no default: the ChatRoom is bundled for Workers by esbuild, where `import.meta.env` is not replaced.
 */
export function resolvePushTransport(
  binding: PushServiceBinding | undefined,
  isDev: boolean,
): PushTransport | undefined {
  if (binding) return createCloudflarePushTransport(binding);
  if (isDev) {
    return {
      async send(deliveries) {
        const batches = splitPushBatches(deliveries);
        return (await Promise.all(batches.map((batch) => deliverPushBatch(batch)))).flat();
      },
    };
  }
  if (!loggedMissingPushBinding) {
    loggedMissingPushBinding = true;
    logLine({ config: 'push_binding_unavailable' });
  }
  return undefined;
}
