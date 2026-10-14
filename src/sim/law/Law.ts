/**
 * The rules module for crime. It is event-sourced: it reads the events the other systems emit
 * (`carjack`, `damage`, `vehicle:enter`), decides what crime each one is, finds the witnesses, and
 * turns their phone calls (and what the police see for themselves) into heat. Nothing in here
 * moves a body except to make a witness run.
 *
 * Witnesses: any civilian within the crime's witness radius with a clear line to it (a ray against
 * the static world), and the victim always counts. A witness calls it in a few seconds later
 * unless they have been knocked down or killed by then. An officer who sees it reports it at once.
 */
import { CRIMES, LAW_RULES, type CrimeId, type LawData } from '../../shared/law';
import type { CrimeDescription, SimEvent } from '../../shared/protocol';
import type { EntityId } from '../../shared/entities';
import { GROUPS } from '../physics/rapier';
import { PedEntity, VehicleEntity } from '../entities';
import type { Simulation } from '../Simulation';
import type { SimSystem } from '../systems';
import { HeatModel } from './heat';

const EYE = 1.55;

interface PendingCall {
  witnessId: EntityId;
  crime: CrimeId;
  /** Tick the call is made. */
  at: number;
  heat: number;
  severity: number;
  x: number;
  z: number;
}

export class Law {
  readonly heat: HeatModel;
  /** What the police know about the culprit; reset when the heat clears. */
  description: CrimeDescription = { vehicle: null, clothes: -1, face: false, cctv: false };
  readonly pending: PendingCall[] = [];
  private readonly recent = new Map<string, number>();
  private readonly rng;

  constructor(
    private readonly sim: Simulation,
    readonly data: LawData,
  ) {
    this.rng = sim.rng.fork('law');
    this.heat = new HeatModel(LAW_RULES, (c) => {
      sim.emit({ type: 'heat:change', tick: sim.tick, ...c, lastKnown: this.heat.lastKnown ? { ...this.heat.lastKnown } : null });
      if (c.level === 0) {
        this.pending.length = 0;
        this.description = { vehicle: null, clothes: -1, face: false, cctv: false };
      }
    });
  }

  /** True when a ray from `from` to `to` is not blocked by the static world. */
  clearLine(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return true;
    const R = this.sim.physics.R;
    const ray = new R.Ray(from, { x: dx / d, y: dy / d, z: dz / d });
    return !this.sim.physics.world.castRay(ray, d - 0.3, true, undefined, GROUPS.cameraQuery);
  }

  /** Clears everything (busted or wasted). */
  clear(reason: 'busted' | 'wasted') {
    this.pending.length = 0;
    this.heat.clear(reason);
  }

  private handle(e: SimEvent) {
    const sim = this.sim;
    switch (e.type) {
      case 'carjack': {
        const perp = sim.registry.get(e.pedId) as PedEntity | undefined;
        const veh = sim.registry.get(e.vehicleId) as VehicleEntity | undefined;
        if (veh) veh.playerOwned = perp?.role === 'player';
        if (perp?.role === 'player') this.crime('carjack', e.x, e.y, e.z, perp, e.victimId, e.vehicleId);
        break;
      }
      case 'damage': {
        const perp = sim.registry.get(e.sourceId) as PedEntity | undefined;
        const target = sim.registry.get(e.targetId) as PedEntity | undefined;
        if (!perp || perp.role !== 'player' || !target || target.role === 'player') break;
        if (e.kind !== 'melee' && e.kind !== 'vehicle') break;
        const police = target.role === 'police';
        let id: CrimeId;
        if (police) id = 'assault_officer';
        else if (e.fatal) id = 'kill_ped';
        else id = e.kind === 'vehicle' ? 'hit_ped' : 'assault';
        this.crime(id, e.x, e.y, e.z, perp, e.targetId, e.vehicleId ?? 0);
        break;
      }
      case 'vehicle:enter': {
        const ped = sim.registry.get(e.pedId) as PedEntity | undefined;
        const veh = sim.registry.get(e.vehicleId) as VehicleEntity | undefined;
        if (!ped || ped.role !== 'player' || !veh) break;
        const stolen = !veh.playerOwned;
        veh.playerOwned = true;
        if (stolen) {
          const p = veh.car.pose();
          this.crime('vehicle_theft', p.x, p.y, p.z, ped, 0, veh.id);
        }
        break;
      }
    }
  }

  /** Records a crime and sets its witnesses to work. `vehicle_theft` only counts if someone saw it. */
  crime(id: CrimeId, x: number, y: number, z: number, perp: PedEntity, victimId: EntityId, vehicleId: EntityId) {
    const sim = this.sim;
    const def = CRIMES[id];
    const key = `${id}:${perp.id}:${victimId}:${vehicleId}`;
    const last = this.recent.get(key);
    if (last !== undefined && sim.tick - last < LAW_RULES.dedupeS * 60) return;

    const at = { x, y: y + 1.2, z };
    const witnesses: PedEntity[] = [];
    let officerSaw: PedEntity | null = null;
    for (const p of sim.peds()) {
      if (p === perp || p.life !== 'alive') continue;
      const c = p.controller;
      const victim = p.id === victimId;
      if (!victim) {
        if (Math.hypot(c.x - x, c.z - z) > def.witnessRadius) continue;
        if (!this.clearLine({ x: c.x, y: c.y + EYE, z: c.z }, at)) continue;
      }
      if (p.role === 'police') {
        officerSaw ??= p;
        continue;
      }
      if (p.role === 'civilian') witnesses.push(p);
    }
    if (id === 'vehicle_theft' && witnesses.length === 0 && !officerSaw) return;
    this.recent.set(key, sim.tick);

    // The record of who did it.
    const veh = (vehicleId ? sim.registry.get(vehicleId) : perp.vehicleId ? sim.registry.get(perp.vehicleId) : undefined) as VehicleEntity | undefined;
    const d = this.description;
    d.clothes = perp.outfit;
    if (veh) d.vehicle = { id: veh.id, typeId: veh.typeId, plate: veh.plate, color: veh.color };
    if (witnesses.length > 0) d.face = true;
    sim.emit({
      type: 'crime', tick: sim.tick, crime: id, severity: def.severity, heat: def.heat, x, y, z,
      perpetratorId: perp.id, victimId, vehicleId: veh?.id ?? 0, witnesses: witnesses.length + (officerSaw ? 1 : 0),
      description: { ...d, vehicle: d.vehicle ? { ...d.vehicle } : null },
    });

    for (const w of witnesses) {
      const existing = this.pending.find((c) => c.witnessId === w.id);
      if (existing) {
        existing.heat = Math.max(existing.heat, def.heat);
        existing.severity = Math.max(existing.severity, def.severity);
      } else {
        const delay = this.rng.range(LAW_RULES.callDelayS[0], LAW_RULES.callDelayS[1]);
        this.pending.push({ witnessId: w.id, crime: id, at: sim.tick + Math.round(delay * 60), heat: def.heat, severity: def.severity, x, z });
      }
      // Bystanders run (the victim of a carjack already reacts in their own way).
      const b = w.brain;
      if (b && w.id !== victimId && (b.state === 'idle' || b.state === 'calm')) b.enter('flee');
    }
    if (officerSaw) {
      this.heat.report(def.heat, def.severity, x, z, true);
      sim.emit({ type: 'crime:reported', tick: sim.tick, crime: id, reporterId: officerSaw.id, police: true, x, z });
    }
  }

  private report(call: PendingCall) {
    this.heat.report(call.heat, call.severity, call.x, call.z);
    this.sim.emit({ type: 'crime:reported', tick: this.sim.tick, crime: call.crime, reporterId: call.witnessId, police: false, x: call.x, z: call.z });
  }

  update(dt: number) {
    const sim = this.sim;
    for (const e of sim.takeRuleEvents()) this.handle(e);

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const call = this.pending[i];
      const w = sim.registry.get(call.witnessId) as PedEntity | undefined;
      if (w && w.life !== 'alive') {
        // Knocked down or killed before they could call.
        sim.emit({ type: 'witness:silenced', tick: sim.tick, pedId: call.witnessId, crime: call.crime });
        this.pending.splice(i, 1);
      } else if (!w || sim.tick >= call.at) {
        // A witness who ran out of the world got the call in on the way.
        this.pending.splice(i, 1);
        this.report(call);
      }
    }

    const seen = sim.police.seesPlayer && this.heat.level > 0;
    if (seen) {
      const p = sim.playerPosition();
      this.heat.sight(p.x, p.z);
    }
    this.heat.step(dt, seen);
  }
}

export class LawSystem implements SimSystem {
  readonly name = 'law';
  readonly priority = 80;

  fixedUpdate(sim: Simulation, dt: number) {
    sim.law.update(dt);
  }
}
