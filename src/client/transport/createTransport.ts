import type { Transport } from '../../shared/transport';
import { ImpairedTransport } from './ImpairedTransport';
import { WorkerTransport } from './WorkerTransport';

/**
 * Picks a transport from the URL: `?transport=loopback|worker`, `?shared=0` (no shared memory),
 * `?lag=ms&jitter=ms&loss=0..1`. The loopback transport pulls the whole simulation (and Rapier)
 * into the main bundle, so it is only imported when it is wanted.
 */
export async function createTransport(params: URLSearchParams): Promise<Transport> {
  const want = params.get('transport');
  let t: Transport | null = null;
  if (want !== 'loopback' && typeof Worker !== 'undefined') {
    try {
      t = new WorkerTransport(params.get('shared') === '0' ? false : undefined);
    } catch (e) {
      console.warn('worker transport unavailable, running the sim on the main thread', e);
    }
  }
  if (!t) {
    const { LoopbackTransport } = await import('./LoopbackTransport');
    t = new LoopbackTransport();
  }
  const lag = Number(params.get('lag') ?? 0);
  const loss = Number(params.get('loss') ?? 0);
  if (lag > 0 || loss > 0) t = new ImpairedTransport(t, { lagMs: lag, jitterMs: Number(params.get('jitter') ?? 0), loss });
  return t;
}
