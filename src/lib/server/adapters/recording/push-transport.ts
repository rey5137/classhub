import type {
  PushDeliveryRequest,
  PushDeliveryResult,
  PushTransport,
} from '../../ports/push-transport';

export interface RecordedPushDelivery extends PushDeliveryRequest {
  status: number | 'network_error';
}

type PushStatus = number | 'network_error';
type PushStatusHandler = (delivery: PushDeliveryRequest) => PushStatus | Promise<PushStatus>;

export interface RecordingPushTransport extends PushTransport {
  readonly deliveries: RecordedPushDelivery[];
  clear(): void;
  setNextStatus(statusOrHandler: PushStatus | PushStatusHandler): void;
}

/** R-NTF-05: test adapter that records deliveries and returns scripted statuses. */
export function createRecordingPushTransport(
  defaultStatusOrHandler: PushStatus | PushStatusHandler = 201,
): RecordingPushTransport {
  const deliveries: RecordedPushDelivery[] = [];
  let handler: PushStatusHandler | undefined =
    typeof defaultStatusOrHandler === 'function' ? defaultStatusOrHandler : undefined;
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
