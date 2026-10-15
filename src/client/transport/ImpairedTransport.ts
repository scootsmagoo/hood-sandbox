/**
 * Wraps a transport and delays (and optionally drops) what crosses it, in both directions, so the
 * interpolation and the input path can be tested against a bad network long before there is one.
 * `?lag=80&jitter=20&loss=0.05` in the URL turns it on.
 */
import type { InputCommand, SimEvent, SimInit, SimReady, SimStats } from '../../shared/protocol';
import type { SnapshotView } from '../../shared/snapshot';
import type { Transport } from '../../shared/transport';

export interface Impairment {
  /** One-way delay, ms. */
  lagMs: number;
  jitterMs: number;
  /** Chance (0 to 1) that a snapshot or an input is dropped. Events are never dropped. */
  loss: number;
}

interface Timed<T> {
  at: number;
  item: T;
}

export class ImpairedTransport implements Transport {
  private inbound: Timed<SnapshotView>[] = [];
  private inboundEvents: Timed<SimEvent>[] = [];
  private outbound: Timed<InputCommand>[] = [];

  constructor(
    private readonly inner: Transport,
    private readonly imp: Impairment,
    private readonly now: () => number = () => performance.now(),
    private readonly random: () => number = Math.random,
  ) {}

  get kind() {
    return `${this.inner.kind}+lag${this.imp.lagMs}`;
  }
  get shared() {
    return this.inner.shared;
  }
  get stats(): SimStats | null {
    return this.inner.stats;
  }

  start(init: SimInit): Promise<SimReady> {
    return this.inner.start(init);
  }

  private delay() {
    return this.now() + this.imp.lagMs + (this.random() - 0.5) * 2 * this.imp.jitterMs;
  }

  config(c: { pedBudget?: number; traffic?: number }) {
    this.inner.config?.(c);
  }

  sendInput(cmd: InputCommand) {
    if (this.random() < this.imp.loss) return;
    this.outbound.push({ at: this.delay(), item: cmd });
    this.flushOutbound();
  }

  private flushOutbound() {
    const t = this.now();
    this.outbound.sort((a, b) => a.at - b.at);
    while (this.outbound.length && this.outbound[0].at <= t) this.inner.sendInput(this.outbound.shift()!.item);
  }

  drainSnapshots(): SnapshotView[] {
    this.flushOutbound();
    for (const s of this.inner.drainSnapshots()) if (this.random() >= this.imp.loss) this.inbound.push({ at: this.delay(), item: s });
    return this.release(this.inbound);
  }

  drainEvents(): SimEvent[] {
    for (const e of this.inner.drainEvents()) this.inboundEvents.push({ at: this.delay(), item: e });
    return this.release(this.inboundEvents);
  }

  private release<T>(q: Timed<T>[]): T[] {
    const t = this.now();
    q.sort((a, b) => a.at - b.at);
    const out: T[] = [];
    while (q.length && q[0].at <= t) out.push(q.shift()!.item);
    return out;
  }

  dispose() {
    this.inner.dispose();
  }
}
