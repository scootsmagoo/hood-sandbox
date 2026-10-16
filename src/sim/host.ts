/**
 * Runs a Simulation on a clock and talks to the outside through a sink. The same host sits behind
 * the Web Worker, the loopback transport and (later) a server socket; only the sink differs.
 */
import { SIM_DT, type FromSim, type InputCommand, type SimEvent, type SimInit, type SimStats } from '../shared/protocol';
import { SnapshotRing } from '../shared/ring';
import { SNAPSHOT_BYTES, SnapshotView } from '../shared/snapshot';
import { loadTileOrFallback } from '../shared/tile';
import { Simulation } from './Simulation';
import { RINGS } from '../shared/city';
import type { TileSource } from './stream/TileSource';
import { fixtureOptions } from '../shared/city';

export interface HostSink {
  /** The sink owns the buffer (it may be transferred). */
  snapshot(buffer: ArrayBuffer): void;
  message(msg: Exclude<FromSim, { type: 'snapshot' }>): void;
}

/** Most ticks run in one pass of the clock; beyond that the sim slows down instead of spiralling. */
const MAX_CATCH_UP = 5;

export class SimHost {
  private sim: Simulation | null = null;
  private ring: SnapshotRing | null = null;
  private readonly view = new SnapshotView();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private acc = 0;
  private stepTotal = 0;
  private stepMax = 0;
  private stepCount = 0;
  private pendingEvents: SimEvent[] = [];

  constructor(private readonly sink: HostSink) {}

  get simulation(): Simulation | null {
    return this.sim;
  }

  async init(init: SimInit) {
    try {
      // (the sources load lazily: the fixture brings the pipeline's lane generator with it)
      let source: TileSource | null = null;
      if (init.cityUrl) {
        const { FixtureTileSource, HttpTileSource } = await import('./stream/TileSource');
        source = init.cityUrl.startsWith('fixture') ? new FixtureTileSource(fixtureOptions(init.cityUrl)) : await HttpTileSource.open(init.cityUrl);
      }
      const tile = source ? null : await loadTileOrFallback(init.tileBaseUrl, init.seed);
      // the city's airport (src/shared/aeroway.ts): the AI aircraft fly from its taxi graph
      const aeroway = source?.index.aeroway && init.cityUrl && !init.cityUrl.startsWith('fixture') && init.aircraft !== false ? await loadAeroway(init.cityUrl, source.index.aeroway) : null;
      const common = {
        seed: init.seed,
        vehicleType: init.vehicleType,
        start: init.start,
        startAtVehicle: init.startAtVehicle,
        driverMood: init.driverMood,
        parkedCars: init.parkedCars,
        bystanders: init.bystanders,
        armour: init.armour,
        weapons: init.weapons,
        clock: init.clock,
        ambientPeds: init.ambientPeds ?? true,
        pedBudget: this.pendingBudget ?? init.pedBudget,
        traffic: this.pendingTraffic ?? init.traffic,
        transit: init.transit ?? true,
        aeroway,
        aircraft: init.aircraft ?? true,
      };
      const sim = source
        ? await Simulation.createCity({ ...common, source, streamOptions: { rings: RINGS[init.streamTier ?? 'high'] } })
        : await Simulation.create({ ...common, tile: tile! });
      this.sim = sim;
      if (init.snapshotBuffer) this.ring = new SnapshotRing(init.snapshotBuffer, SNAPSHOT_BYTES);
      this.sink.message({
        type: 'ready',
        info: {
          tile: sim.tile.manifest,
          city: source?.index,
          tileSource: sim.tile.source,
          fallbackReason: sim.tile.fallbackReason,
          playerId: sim.playerPedId,
          vehicleId: sim.vehicleId,
          vehicleType: sim.vehicleType,
          entities: sim.entityDefs(),
          sharedSnapshots: this.ring !== null,
        },
      });
      this.publish();
      if (init.autoRun) this.start();
    } catch (e) {
      this.sink.message({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
    }
  }

  /** Settings that change while the sim runs. */
  config(c: { pedBudget?: number; traffic?: number }) {
    if (c.traffic !== undefined && this.sim?.traffic) this.sim.traffic.density = Math.max(0, Math.min(1, c.traffic));
    else if (c.traffic !== undefined) this.pendingTraffic = c.traffic;
    if (c.pedBudget !== undefined && this.sim?.ambient) this.sim.ambient.budget = c.pedBudget;
    else if (c.pedBudget !== undefined) this.pendingBudget = c.pedBudget;
  }

  private pendingBudget: number | undefined;
  private pendingTraffic: number | undefined;

  input(cmd: InputCommand) {
    this.sim?.pushInput(1, cmd);
  }

  start() {
    if (this.timer) return;
    this.last = performance.now();
    this.acc = 0;
    this.timer = setInterval(() => this.pump(), 4);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private pump() {
    const now = performance.now();
    this.acc += Math.min(now - this.last, 250);
    this.last = now;
    const dtMs = SIM_DT * 1000;
    let n = 0;
    while (this.acc >= dtMs && n < MAX_CATCH_UP) {
      this.acc -= dtMs;
      this.advanceOne();
      n++;
    }
    if (n === MAX_CATCH_UP) this.acc = 0;
    this.flushEvents();
  }

  /** Runs `ticks` ticks now (manual clock, used by tests). */
  advance(ticks: number) {
    for (let i = 0; i < ticks; i++) this.advanceOne();
    this.flushEvents();
  }

  private advanceOne() {
    const sim = this.sim;
    if (!sim) return;
    const t0 = performance.now();
    sim.step();
    const ms = performance.now() - t0;
    this.stepTotal += ms;
    this.stepMax = Math.max(this.stepMax, ms);
    if (++this.stepCount >= 60) {
      const stats: SimStats = { tick: sim.tick, stepMs: this.stepTotal / this.stepCount, stepMaxMs: this.stepMax };
      this.sink.message({ type: 'stats', stats });
      this.stepTotal = this.stepMax = this.stepCount = 0;
    }
    const ev = sim.drainEvents();
    if (ev.length) this.pendingEvents.push(...ev);
    this.publish();
  }

  private flushEvents() {
    if (this.pendingEvents.length === 0) return;
    this.sink.message({ type: 'events', events: this.pendingEvents });
    this.pendingEvents = [];
  }

  private publish() {
    const sim = this.sim;
    if (!sim) return;
    sim.writeSnapshot(this.view);
    const used = this.view.usedBytes;
    if (this.ring) {
      this.ring.write(new Uint8Array(this.view.buffer, 0, used));
    } else {
      this.sink.snapshot(this.view.buffer.slice(0, used));
    }
  }
}

/** The city's `aeroway.json` (relative to its index), parsed; null when it cannot be read (the city goes on without aircraft). */
async function loadAeroway(cityUrl: string, rel: string) {
  try {
    const { parseAeroway } = await import('../shared/aeroway');
    const base = cityUrl.endsWith('.json') ? cityUrl.slice(0, cityUrl.lastIndexOf('/') + 1) : cityUrl.endsWith('/') ? cityUrl : `${cityUrl}/`;
    const res = await fetch(new URL(rel, base).href);
    if (!res.ok) return null;
    return parseAeroway(await res.json());
  } catch (e) {
    console.warn(`aeroway: ${(e as Error).message}`);
    return null;
  }
}
