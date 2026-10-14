/**
 * How the presentation talks to a simulation. Today that is a Web Worker or a call into the same
 * thread; later a WebSocket to a server. Game code only ever sees this interface.
 */
import type { InputCommand, SimEvent, SimInit, SimReady, SimStats } from './protocol';
import type { SnapshotView } from './snapshot';

export interface Transport {
  readonly kind: string;
  /** True when snapshots arrive through shared memory instead of messages. */
  readonly shared: boolean;
  start(init: SimInit): Promise<SimReady>;
  sendInput(cmd: InputCommand): void;
  /** Snapshots that arrived since the last call, oldest first. The caller owns the views. */
  drainSnapshots(): SnapshotView[];
  drainEvents(): SimEvent[];
  /** The newest timing report from the sim, if any. */
  readonly stats: SimStats | null;
  dispose(): void;
}
