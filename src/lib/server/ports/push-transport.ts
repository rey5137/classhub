// §11.3 / R-NTF-05: Web Push delivery port. Payloads arrive encrypted and VAPID-signed.

export interface PushDeliveryRequest {
  subscriptionId: string;
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PushDeliveryResult {
  subscriptionId: string;
  status: number | 'network_error';
}

export interface PushTransport {
  // R-NTF-05: payloads already encrypted and VAPID-signed; returns one status per delivery for R-NTF-06
  send(
    deliveries: {
      subscriptionId: string;
      endpoint: string;
      headers: Record<string, string>;
      body: Uint8Array;
    }[],
  ): Promise<{ subscriptionId: string; status: number | 'network_error' }[]>;
}
