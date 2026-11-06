import type {
  PushDeliveryRequest,
  PushDeliveryResult,
  PushTransport,
} from '../../ports/push-transport';
import { deliverPushRequest } from '../../push/deliver';

/** R-NTF-05: in-process Web Push transport for `dev:offline`; encrypts and sends each delivery. */
export function createLocalPushTransport(fetchFn: typeof fetch = globalThis.fetch): PushTransport {
  return {
    async send(deliveries: PushDeliveryRequest[]): Promise<PushDeliveryResult[]> {
      return Promise.all(deliveries.map((item) => deliverPushRequest(item, fetchFn)));
    },
  };
}
