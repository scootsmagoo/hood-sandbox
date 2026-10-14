/**
 * The simulation on the calling thread. Used for tests, for browsers without module workers and
 * for debugging (the sim shows up in the main thread's profiler). With `manual` set the clock does
 * not run by itself; call `advance(ticks)`.
 */
import type { InputCommand, SimEvent, SimInit, SimReady, SimStats } from '../../shared/protocol';
import { SnapshotView } from '../../shared/snapshot';
import type { Transport } from '../../shared/transport';
import { SimHost } from '../../sim/host';

export class LoopbackTransport implements Transport {
  readonly kind = 'loopback';
  readonly shared = false;
  stats: SimStats | null = null;
  readonly host: SimHost;
  private snapshots: SnapshotView[] = [];
  private events: SimEvent[] = [];

  constructor(private readonly opts: { manual?: boolean } = {}) {
    this.host = new SimHost({
      snapshot: (buffer) => this.snapshots.push(new SnapshotView(buffer)),
      message: (msg) => {
        if (msg.type === 'events') this.events.push(...msg.events);
        else if (msg.type === 'stats') this.stats = msg.stats;
        else if (msg.type === 'error') this.error = msg.message;
        else if (msg.type === 'ready') this.onReady?.(msg.info);
      },
    });
  }

  error: string | null = null;
  private onReady: ((info: SimReady) => void) | null = null;

  start(init: SimInit): Promise<SimReady> {
    return new Promise((resolve, reject) => {
      this.onReady = resolve;
      void this.host.init({ ...init, snapshotBuffer: undefined, autoRun: init.autoRun && !this.opts.manual }).then(() => {
        if (this.error) reject(new Error(this.error));
      });
    });
  }

  sendInput(cmd: InputCommand) {
    this.host.input(cmd);
  }

  /** Runs ticks now. Manual clock only. */
  advance(ticks: number) {
    this.host.advance(ticks);
  }

  drainSnapshots(): SnapshotView[] {
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
    this.host.stop();
  }
}
