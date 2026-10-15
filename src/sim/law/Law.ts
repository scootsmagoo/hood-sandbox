/**
 * The rules module for crime. It is event-sourced: it reads the events the other systems emit
 * (`carjack`, `damage`, `vehicle:enter`), decides what crime each one is, finds the witnesses, and
 * turns their phone calls (and what the police see for themselves) into heat. Nothing in here
 * moves a body except to make a witness run.
 *
 * Witnesses: any civilian within the crime's witness radius with a clear line to it (a ray against
 * the static world), and the victim always counts; gunfire is also heard through walls. Not every
 * witness calls: each rolls (`callChance`, `heardCallChance`, `victimCallChance`) and the ones who
 * decline just run. A caller takes 8 to 20 s to get through (`callDelayS`), is shown dialling over
 * their head, and hangs up if they are knocked down or killed (`witness:silenced`), lose sight of the
 * culprit for `giveUp.lostSightS`, or run farther than `giveUp.runAwayM` from the scene
 * (`witness:gave-up`). Several calls about one crime are one report: only the first raises heat, and
 * what it raises is the crime's own level plus its points (`heat.ts`). An officer who sees it
 * reports it at once.
 */
import { CRIMES, LAW_RULES, type CrimeDef, type CrimeId, type LawData, type LawRules } from '../../shared/law';
import { PedPose } from '../../shared/snapshot';
import { WEAPONS } from '../../shared/weapons';
import type { CrimeDescription, SimEvent } from '../../shared/protocol';
import type { EntityId } from '../../shared/entities';
import { GROUPS } from '../physics/rapier';
import { PedEntity, VehicleEntity } from '../entities';
import type { Simulation } from '../Simulation';
import type { SimSystem } from '../systems';
import { HeatModel } from './heat';

const EYE = 1.55;

/** One crime as the law holds it: reported once, however many witnesses call it in. */
interface CrimeRecord {
  id: number;
  crime: CrimeId;
  def: CrimeDef;
  x: number;
  z: number;
  reported: boolean;
}

interface PendingCall {
  witnessId: EntityId;
  crime: CrimeId;
  /** Tick the call started and the tick it is made. */
  from: number;
  at: number;
  heat: number;
  severity: number;
  x: number;
  z: number;
  /** The crimes this call is about (a witness who is already dialling adds the new ones to the same call). */
  records: CrimeRecord[];
  /** The witness saw the culprit (those who only heard it cannot lose sight of them). */
  saw: boolean;
  /** The victim: they run, but they call from wherever they stop (see `giveUp.victimLostSightS`). */
  victim: boolean;
  /** Seconds without a clear line to the culprit. */
  lostT: number;
}

export class Law {
  readonly heat: HeatModel;
  /** What the police know about the culprit; reset when the heat clears. */
  description: CrimeDescription = { vehicle: null, clothes: -1, face: false, cctv: false };
  readonly pending: PendingCall[] = [];
  /** The law's tunables, a copy of `crimes.json` rules so a test can change them for one sim. */
  readonly rules: LawRules = { ...LAW_RULES, giveUp: { ...LAW_RULES.giveUp }, escalation: { ...LAW_RULES.escalation } };
  private readonly recent = new Map<string, number>();
  /** Witnesses who decided not to call, and the tick until which they are not asked again. */
  private readonly declined = new Map<EntityId, number>();
  private nextRecord = 1;
  private readonly rng;

  constructor(
    private readonly sim: Simulation,
    readonly data: LawData,
  ) {
    this.rng = sim.rng.fork('law');
    this.heat = new HeatModel(this.rules, (c) => {
      sim.emit({ type: 'heat:change', tick: sim.tick, ...c, lastKnown: this.heat.lastKnown ? { ...this.heat.lastKnown } : null });
      if (c.level === 0) {
        this.dropCalls();
        this.declined.clear();
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
    this.dropCalls();
    this.declined.clear();
    this.heat.clear(reason);
  }

  /** Hangs up every call in progress. */
  private dropCalls() {
    for (const c of this.pending) this.endCall(c);
    this.pending.length = 0;
  }

  /** A call is over, however it ended: the witness puts the phone away. */
  private endCall(call: PendingCall) {
    const w = this.sim.registry.get(call.witnessId) as PedEntity | undefined;
    if (!w) return;
    w.dial = -1;
    if (w.pose === PedPose.Phone && !w.amb) w.pose = 0;
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
        if (e.kind !== 'melee' && e.kind !== 'vehicle' && e.kind !== 'bullet') break;
        const police = target.role === 'police';
        let id: CrimeId;
        // Shooting an officer is the same crime as hitting one (the shot itself is heard as a discharge).
        if (police) id = 'assault_officer';
        else if (e.fatal) id = 'kill_ped';
        else id = e.kind === 'vehicle' ? 'hit_ped' : e.kind === 'bullet' ? 'shoot_ped' : 'assault';
        this.crime(id, e.x, e.y, e.z, perp, e.targetId, e.vehicleId ?? 0, e.kind === 'bullet' ? this.hearScale(e.sourceId) : 1);
        break;
      }
      case 'weapon:fire': {
        // Firing in public. Anyone within earshot (further than they can see) takes note.
        const perp = sim.registry.get(e.shooterId) as PedEntity | undefined;
        if (perp?.role === 'player') this.crime('discharge', e.x, e.y, e.z, perp, 0, 0, WEAPONS[e.weapon].hearM);
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
  crime(id: CrimeId, x: number, y: number, z: number, perp: PedEntity, victimId: EntityId, vehicleId: EntityId, hearScale = 1) {
    const sim = this.sim;
    const def = CRIMES[id];
    const key = `${id}:${perp.id}:${victimId}:${vehicleId}`;
    const last = this.recent.get(key);
    if (last !== undefined && sim.tick - last < LAW_RULES.dedupeS * 60) return;

    const at = { x, y: y + 1.2, z };
    const witnesses: PedEntity[] = [];
    /** Who of the witnesses saw the culprit (the rest only heard). */
    const saw = new Set<EntityId>();
    let officerSaw: PedEntity | null = null;
    // Sound carries further than sight and needs no line: gunfire has a hearRadius.
    const hearR = (def.hearRadius ?? 0) * hearScale;
    let heard = 0;
    let seenBy = 0;
    for (const p of sim.peds()) {
      if (p === perp || p.life !== 'alive') continue;
      const c = p.controller;
      const victim = p.id === victimId;
      if (!victim) {
        const dist = Math.hypot(c.x - x, c.z - z);
        if (dist > Math.max(def.witnessRadius, hearR)) continue;
        const sees = dist <= def.witnessRadius && this.clearLine({ x: c.x, y: c.y + EYE, z: c.z }, at);
        if (!sees && dist > hearR) continue;
        if (!sees && p.role === 'civilian') heard++;
        else if (p.role === 'civilian') {
          seenBy++;
          saw.add(p.id);
        }
      } else {
        seenBy++;
        saw.add(p.id);
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
    // Someone who only heard it did not see a face.
    if (seenBy > 0) d.face = true;
    sim.emit({
      type: 'crime', tick: sim.tick, crime: id, severity: def.severity, heat: def.heat, x, y, z,
      perpetratorId: perp.id, victimId, vehicleId: veh?.id ?? 0, witnesses: witnesses.length + (officerSaw ? 1 : 0), heard,
      description: { ...d, vehicle: d.vehicle ? { ...d.vehicle } : null },
    });

    const rec: CrimeRecord = { id: this.nextRecord++, crime: id, def, x, z, reported: false };
    const R = this.rules;
    for (const w of witnesses) {
      const existing = this.pending.find((c) => c.witnessId === w.id);
      let calls = !!existing;
      if (existing) {
        // Already dialling: this goes into the same call.
        existing.records.push(rec);
        existing.heat = Math.max(existing.heat, def.heat);
        existing.severity = Math.max(existing.severity, def.severity);
        existing.saw ||= saw.has(w.id);
      } else if ((this.declined.get(w.id) ?? 0) <= sim.tick) {
        // Not everyone calls: some just run.
        const chance = w.id === victimId ? R.victimCallChance : saw.has(w.id) ? R.callChance : R.heardCallChance;
        calls = this.rng.chance(chance);
        if (calls) {
          const delay = this.rng.range(R.callDelayS[0], R.callDelayS[1]);
          this.pending.push({ witnessId: w.id, crime: id, from: sim.tick, at: sim.tick + Math.round(delay * 60), heat: def.heat, severity: def.severity, x, z, records: [rec], saw: saw.has(w.id), victim: w.id === victimId, lostT: 0 });
        } else this.declined.set(w.id, sim.tick + Math.round(R.declineMemoryS * 60));
      }
      // Bystanders who are not calling run (the victim of a carjack already reacts in their own way, and
      // a caller stays put with the phone out). Ambient people react to gunfire by themselves, each in
      // their own way: running, cowering, filming.
      const b = w.brain;
      if (!calls && b && w.id !== victimId && !(w.amb && def.hearRadius) && (b.state === 'idle' || b.state === 'calm')) b.enter('flee');
    }
    if (officerSaw) {
      rec.reported = true;
      this.heat.report(def.heat, def.severity, x, z, true, { points: def.points, violent: def.violent });
      sim.emit({ type: 'crime:reported', tick: sim.tick, crime: id, reporterId: officerSaw.id, police: true, x, z });
    }
  }

  /** How far a shooter's gun carries, relative to the crime's hearRadius. */
  private hearScale(shooterId: EntityId): number {
    const g = (this.sim.registry.get(shooterId) as PedEntity | undefined)?.gun;
    return g ? WEAPONS[g.weapon].hearM : 1;
  }

  /** A call goes through. Each crime in it is reported once: a crime someone already called in (or an officer saw) adds nothing. */
  private report(call: PendingCall) {
    let fresh = false;
    for (const rec of call.records) {
      if (rec.reported) continue;
      rec.reported = true;
      fresh = true;
      this.heat.report(rec.def.heat, rec.def.severity, rec.x, rec.z, false, { points: rec.def.points, violent: rec.def.violent });
    }
    this.sim.emit({ type: 'crime:reported', tick: this.sim.tick, crime: call.crime, reporterId: call.witnessId, police: false, x: call.x, z: call.z, ...(fresh ? {} : { duplicate: true }) });
  }

  /** Whether a caller can still see the culprit: close enough, with a clear line. */
  private seesCulprit(w: PedEntity): boolean {
    const G = this.rules.giveUp;
    const c = w.controller;
    const p = this.sim.playerPosition();
    if (Math.hypot(c.x - p.x, c.z - p.z) > G.sightRangeM) return false;
    return this.clearLine({ x: c.x, y: c.y + EYE, z: c.z }, { x: p.x, y: p.y + 1.2, z: p.z });
  }

  update(dt: number) {
    const sim = this.sim;
    for (const e of sim.takeRuleEvents()) this.handle(e);

    const G = this.rules.giveUp;
    if (sim.tick % 600 === 0) for (const [id, until] of this.declined) if (until <= sim.tick) this.declined.delete(id);
    // Looking is the costly part (a ray each): every caller does it ten times a second, staggered.
    const sense = sim.tick % 6 === 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const call = this.pending[i];
      const w = sim.registry.get(call.witnessId) as PedEntity | undefined;
      if (w && w.life !== 'alive') {
        // Knocked down or killed before they could call.
        sim.emit({ type: 'witness:silenced', tick: sim.tick, pedId: call.witnessId, crime: call.crime });
        this.endCall(call);
        this.pending.splice(i, 1);
        continue;
      }
      if (!w) {
        this.pending.splice(i, 1);
        // Gone from the world (ran off and was removed) before the call went through. A bystander who ran
        // off hung up; the victim got the call in on the way.
        if (call.victim) this.report(call);
        else sim.emit({ type: 'witness:gave-up', tick: sim.tick, pedId: call.witnessId, crime: call.crime, reason: 'ran-off' });
        continue;
      }
      let gaveUp: 'lost-sight' | 'ran-off' | null = null;
      if (sense) {
        const c = w.controller;
        if (!call.victim && Math.hypot(c.x - call.x, c.z - call.z) > G.runAwayM) gaveUp = 'ran-off';
        else if (call.saw) {
          call.lostT = this.seesCulprit(w) ? 0 : call.lostT + 0.1;
          if (call.lostT >= (call.victim ? G.victimLostSightS : G.lostSightS)) gaveUp = 'lost-sight';
        }
      }
      if (gaveUp) {
        sim.emit({ type: 'witness:gave-up', tick: sim.tick, pedId: call.witnessId, crime: call.crime, reason: gaveUp });
        this.endCall(call);
        this.pending.splice(i, 1);
        continue;
      }
      if (sim.tick >= call.at) {
        this.endCall(call);
        this.pending.splice(i, 1);
        this.report(call);
        continue;
      }
      // Still dialling: the phone comes out (a caller who is standing about), and the snapshot shows how far along it is.
      w.dial = Math.min(1, (sim.tick - call.from) / Math.max(1, call.at - call.from));
      const b = w.brain;
      if ((b?.state === 'idle' || b?.state === 'calm') && w.controller.speed < 0.6) w.pose = PedPose.Phone;
    }

    const seen = sim.police.seesPlayer && this.heat.level > 0;
    if (seen) {
      const p = sim.playerPosition();
      this.heat.sight(p.x, p.z);
    }
    this.heat.step(dt, seen, sim.police.coolRate(), sim.police.unitEnRoute());
  }
}

export class LawSystem implements SimSystem {
  readonly name = 'law';
  readonly priority = 80;

  fixedUpdate(sim: Simulation, dt: number) {
    sim.law.update(dt);
  }
}
