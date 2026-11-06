import type { PushDeliveryRequest, PushDeliveryResult } from '../ports/push-transport';
import { isAllowedPushEndpoint } from './allow-list';
import { encryptPushPayload } from './encrypt';

const PUSH_FETCH_TIMEOUT_MS = 10_000;

/**
 * R-NTF-05, 06: encrypts one delivery's payload (RFC 8291) and POSTs it to the push service.
 * Unusable key material or a disallowed endpoint is reported as 400, like a rejected push.
 */
export async function deliverPushRequest(
  item: PushDeliveryRequest,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<PushDeliveryResult> {
  if (!isAllowedPushEndpoint(item.endpoint)) {
    return { subscriptionId: item.subscriptionId, status: 400 };
  }
  let body: Uint8Array;
  try {
    body = await encryptPushPayload(item.payload, { p256dh: item.p256dh, auth: item.auth });
  } catch {
    return { subscriptionId: item.subscriptionId, status: 400 };
  }
  try {
    const response = await fetchFn(item.endpoint, {
      method: 'POST',
      headers: item.headers,
      body: body as BodyInit,
      redirect: 'manual',
      signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT_MS),
    });
    return { subscriptionId: item.subscriptionId, status: response.status };
  } catch {
    return { subscriptionId: item.subscriptionId, status: 'network_error' };
  }
}
