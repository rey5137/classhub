import type {
  PushDeliveryRequest,
  PushDeliveryResult,
  PushTransport,
} from '../../ports/push-transport';
import { isAllowedPushEndpoint } from '../../push/allow-list';

const PUSH_FETCH_TIMEOUT_MS = 10_000;

/** R-NTF-05: in-process Web Push transport for `dev:offline`. */
export function createLocalPushTransport(fetchFn: typeof fetch = globalThis.fetch): PushTransport {
  return {
    async send(deliveries: PushDeliveryRequest[]): Promise<PushDeliveryResult[]> {
      return Promise.all(
        deliveries.map(async (item): Promise<PushDeliveryResult> => {
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
    },
  };
}
