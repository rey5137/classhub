import type {
  PushDeliveryRequest,
  PushDeliveryResult,
  PushTransport,
} from '../../ports/push-transport';

export interface RecordedPushDelivery extends PushDeliveryRequest {
  status: number | 'network_error';
}

export interface RecordingPushTransport extends PushTransport {
  readonly deliveries: RecordedPushDelivery[];
  clear(): void;
  setNextStatus(
    statusOrHandler:
      | number
      | 'network_error'
      | ((
          delivery: PushDeliveryRequest,
        ) => number | 'network_error' | Promise<number | 'network_error'>),
  ): void;
}

/** R-NTF-05: test adapter that records deliveries and returns scripted statuses. */
export function createRecordingPushTransport(
  defaultStatusOrHandler:
    | number
    | 'network_error'
    | ((
        delivery: PushDeliveryRequest,
      ) => number | 'network_error' | Promise<number | 'network_error'>) = 201,
): RecordingPushTransport {
  const deliveries: RecordedPushDelivery[] = [];
  let handler:
    | ((
        delivery: PushDeliveryRequest,
      ) => number | 'network_error' | Promise<number | 'network_error'>)
    | undefined = typeof defaultStatusOrHandler === 'function' ? defaultStatusOrHandler : undefined;
  const fallbackStatus =
    typeof defaultStatusOrHandler === 'function' ? 201 : defaultStatusOrHandler;

  return {
    deliveries,
    clear() {
      deliveries.length = 0;
    },
    setNextStatus(statusOrHandler) {
      handler = typeof statusOrHandler === 'function' ? statusOrHandler : () => statusOrHandler;
    },
    async send(batch) {
      const results: PushDeliveryResult[] = [];
      for (const item of batch) {
        const status = handler ? await handler(item) : fallbackStatus;
        deliveries.push({ ...item, status });
        results.push({ subscriptionId: item.subscriptionId, status });
      }
      return results;
    },
  };
}
