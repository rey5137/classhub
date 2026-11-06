import {
  domSurface,
  encodeImage,
  EncodeRefusal,
  offscreenSurface,
  type EncodeMode,
  type Encoded,
} from './encode';
import type { Refusal } from './policy';
import type { WorkerRequest } from './worker';

// R-MEM-04: encode in a worker with OffscreenCanvas where the browser has both, on the
// main thread otherwise. Browser-only: call it from an event handler, never during SSR.

type WorkerMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: Encoded }
  | { type: 'refused'; reason: Refusal }
  | { type: 'failed' };

/** A worker that can't start or can't draw answers `null`, and the main thread takes over. */
function inWorker(
  file: File,
  mode: EncodeMode,
  progress: (fraction: number) => void,
): Promise<Encoded | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    const finish = (settle: () => void) => {
      worker.terminate();
      settle();
    };
    worker.onerror = () => finish(() => resolve(null));
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.type === 'progress') progress(data.fraction);
      else if (data.type === 'done') finish(() => resolve(data.result));
      else if (data.type === 'refused') finish(() => reject(new EncodeRefusal(data.reason)));
      else finish(() => resolve(null));
    };
    worker.postMessage({ file, mode } satisfies WorkerRequest);
  });
}

export async function prepareImage(
  file: File,
  mode: EncodeMode,
  progress: (fraction: number) => void = () => undefined,
): Promise<Encoded> {
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    const result = await inWorker(file, mode, progress);
    if (result) return result;
  }
  const surface = typeof OffscreenCanvas === 'undefined' ? domSurface : offscreenSurface;
  try {
    return await encodeImage(file, mode, surface, progress);
  } catch (error) {
    // OffscreenCanvas without a 2d context or an encoder: the DOM canvas is the last try.
    if (error instanceof EncodeRefusal || surface === domSurface) throw error;
    return encodeImage(file, mode, domSurface, progress);
  }
}

export { EncodeRefusal };
