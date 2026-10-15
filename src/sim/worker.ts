/**
 * Web Worker entry: hosts the simulation off the main thread. Messages are described in
 * shared/protocol.ts. Uses no DOM; only the worker global.
 */
import type { FromSim, ToSim } from '../shared/protocol';
import { SimHost } from './host';

interface WorkerScope {
  postMessage(msg: FromSim, transfer?: ArrayBuffer[]): void;
  onmessage: ((e: { data: ToSim }) => void) | null;
}
const scope = globalThis as unknown as WorkerScope;

const host = new SimHost({
  snapshot: (buffer) => scope.postMessage({ type: 'snapshot', buffer }, [buffer]),
  message: (msg) => scope.postMessage(msg),
});

scope.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      void host.init(msg.init);
      break;
    case 'input':
      host.input(msg.cmd);
      break;
    case 'config':
      host.config(msg);
      break;
    case 'stop':
      host.stop();
      break;
  }
};
