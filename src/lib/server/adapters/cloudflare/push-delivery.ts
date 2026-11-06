import { WorkerEntrypoint } from 'cloudflare:workers';
import type { PushDeliveryRequest, PushDeliveryResult } from '../../ports/push-transport';
import { deliverPushBatch } from './push-transport';

// R-NTF-05: encrypts and sends one batch (<= 40); named entrypoint invoked by the Worker's `PUSH` self service binding.
export class PushDelivery extends WorkerEntrypoint {
  async deliver(batch: PushDeliveryRequest[]): Promise<PushDeliveryResult[]> {
    return deliverPushBatch(batch);
  }
}
