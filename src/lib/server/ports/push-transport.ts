// §11.3 / R-NTF-05: Web Push delivery port. The request carries the plaintext payload and the
// subscription keys: encryption runs where the batch is delivered, so each batch of <= 40 pays
// its own CPU. The VAPID `Authorization` header is signed once per push service per event.

export interface PushDeliveryRequest {
  subscriptionId: string;
  endpoint: string;
  /** The subscription's keys (base64url), for RFC 8291 encryption at delivery. */
  p256dh: string;
  auth: string;
  /** The JSON payload, unencrypted. */
  payload: string;
  headers: Record<string, string>;
}

export interface PushDeliveryResult {
  subscriptionId: string;
  status: number | 'network_error';
}

export interface PushTransport {
  // R-NTF-05: returns one status per delivery for R-NTF-06
  send(deliveries: PushDeliveryRequest[]): Promise<PushDeliveryResult[]>;
}

/** R-NTF-05: Workers Free allows 50 subrequests per invocation; a batch stays at 40, an event at 7 batches. */
export const PUSH_BATCH_SIZE = 40;
export const MAX_PUSH_BATCHES = 7;
export const MAX_PUSH_DELIVERIES_PER_EVENT = PUSH_BATCH_SIZE * MAX_PUSH_BATCHES;
