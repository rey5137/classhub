import { encodeImage, EncodeRefusal, offscreenSurface, type EncodeMode } from './encode';

// R-MEM-04: the module worker that encodes off the main thread. Anything but a
// refusal reports `failed`, and the page then encodes on the main thread instead.

export interface WorkerRequest {
  file: File;
  mode: EncodeMode;
}

interface Scope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as Scope;

scope.onmessage = async ({ data }) => {
  try {
    const result = await encodeImage(data.file, data.mode, offscreenSurface, (fraction) =>
      scope.postMessage({ type: 'progress', fraction }),
    );
    scope.postMessage({ type: 'done', result });
  } catch (error) {
    scope.postMessage(
      error instanceof EncodeRefusal
        ? { type: 'refused', reason: error.reason }
        : { type: 'failed' },
    );
  }
};
