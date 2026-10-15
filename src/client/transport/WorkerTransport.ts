/**
 * The simulation in a dedicated Web Worker. Snapshots come through a SharedArrayBuffer ring when
 * the page is cross-origin isolated, and as transferred buffers otherwise.
 */
import type { FromSim, InputCommand, SimEvent, SimInit, SimReady, SimStats, ToSim } from '../../shared/protocol';
import { SnapshotRing } from '../../shared/ring';
import { SNAPSHOT_BYTES, SnapshotView } from '../../shared/snapshot';
import type { Transport } from '../../shared/transport';

export function canShareMemory(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

export class WorkerTransport implements Transport {
  readonly kind = 'worker';
  stats: SimStats | null = null;
  private worker: Worker;
  private ring: SnapshotRing | null = null;
  private snapshots: SnapshotView[] = [];
  private events: SimEvent[] = [];

  constructor(private readonly useSharedMemory = canShareMemory()) {
    this.worker = new Worker(new URL('../../sim/worker.ts', import.meta.url), { type: 'module', name: 'sim' });
  }

  get shared(): boolean {
    return this.ring !== null;
  }

  start(init: SimInit): Promise<SimReady> {
    return new Promise((resolve, reject) => {
      if (this.useSharedMemory) {
        this.ring = SnapshotRing.create(SNAPSHOT_BYTES);
        init = { ...init, snapshotBuffer: this.ring.buffer };
      }
      this.worker.onmessage = (e: MessageEvent<FromSim>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'ready':
            resolve(msg.info);
            break;
          case 'snapshot':
            this.snapshots.push(new SnapshotView(msg.buffer));
            break;
          case 'events':
            this.events.push(...msg.events);
            break;
          case 'stats':
            this.stats = msg.stats;
            break;
          case 'error':
            reject(new Error(msg.message));
            console.error('[sim]', msg.message);
            break;
        }
      };
      this.worker.onerror = (e) => reject(new Error(`sim worker failed: ${e.message || 'unknown error'}`));
      this.post({ type: 'init', init });
    });
  }

  sendInput(cmd: InputCommand) {
    this.post({ type: 'input', cmd });
  }

  config(c: { pedBudget?: number; traffic?: number }) {
    this.post({ type: 'config', ...c });
  }

  drainSnapshots(): SnapshotView[] {
    if (this.ring) {
      const view = new SnapshotView();
      return this.ring.read(new Uint8Array(view.buffer)) ? [view] : [];
    }
    if (this.snapshots.length === 0) return this.snapshots;
    const out = this.snapshots;
    this.snapshots = [];
    return out;
  }

  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return this.events;
    const out = this.events;
    this.events = [];
    return out;
  }

  dispose() {
    this.post({ type: 'stop' });
    this.worker.terminate();
  }

  private post(msg: ToSim) {
    this.worker.postMessage(msg);
  }
}
