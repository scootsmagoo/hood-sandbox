/**
 * Driving a police car: choosing where to go for the unit's role, routing there over the lanes (or the
 * road centrelines), and steering and braking along the route with pure pursuit. On top of that the
 * tactics of a chase: a PIT from the target's rear quarter, ramming from heat 4, a blocker parking
 * across the road ahead, a flanker coming down a parallel street, and passing slow traffic by taking
 * the next lane over.
 *
 * The roles are given by `PoliceManager.assignRoles`; the pure parts (the PIT geometry, the intercept)
 * are in `tactics.ts`.
 */
import { clamp, rotateVec, wrapAngle } from '../../shared/math';
import { POLICE_RULES } from '../../shared/policeRules';
import { AI_OWNER, type PedEntity, type VehicleEntity } from '../entities';
import { GROUPS } from '../physics/rapier';
import { steerLock } from '../vehicles/dynamics';
import { PathFollower, governSpeed, lookaheadDistance, pedalsFor, pursuitAngle, steerCommand } from './pursuit';
import { pointAlong } from './nav';
import type { PathPoint } from './roadGraph';
import { POLICE } from './constants';
import type { PoliceManager, Target } from './PoliceSystem';
import { planPit, pitSide, type Kin } from './tactics';
import type { Unit, UnitMode } from './types';

const tmpPedals = { throttle: 0, brake: 0 };

/** Distance to whatever is ahead of the car along its nose (walls, other cars), up to 14 m (or `reach`). */
function clearAhead(m: PoliceManager, veh: VehicleEntity, lateral = 0, reach = 14, ignore?: VehicleEntity | null): number {
  const R = m.sim.physics.R;
  const pose = veh.car.pose();
  const half = veh.car.h.chassis.halfExtents;
  const f = rotateVec(pose.q, 0, 0, 1);
  const l = rotateVec(pose.q, 1, 0, 0);
  const hz = half[2];
  const ray = new R.Ray({ x: pose.x + f.x * (hz + 0.1) + l.x * lateral, y: pose.y + 0.35, z: pose.z + f.z * (hz + 0.1) + l.z * lateral }, { x: f.x, y: 0, z: f.z });
  const skip = ignore ? ignore.car.body.handle : -1;
  const hit = m.sim.physics.world.castRay(ray, reach, true, undefined, GROUPS.actorQuery, undefined, veh.car.body, skip >= 0 ? (c) => c.parent()?.handle !== skip : undefined);
  return hit ? hit.timeOfImpact + hz : 99;
}

/** Chooses the lane to be in: the path's own, or the next one over when something slow is in it. */
function chooseLateral(m: PoliceManager, u: Unit, veh: VehicleEntity, dt: number, ignore: VehicleEntity | null) {
  u.lateralT -= dt;
  if (u.lateralT <= 0) {
    u.lateralT = 0.3;
    const lane = m.nav.lanes ? 3.3 : 2.2;
    const here = clearAhead(m, veh, 0, 42, ignore);
    if (here > 30) {
      u.lateralWant = 0;
    } else {
      // (the rays go from the car, which sits about `u.lateral` off the path)
      let best = u.lateralWant;
      let bestFree = u.lateralWant === u.lateral ? here : clearAhead(m, veh, u.lateralWant - u.lateral, 42, ignore);
      for (const cand of [0, lane, -lane]) {
        if (cand === u.lateralWant) continue;
        const free = clearAhead(m, veh, cand - u.lateral, 42, ignore);
        if (free > bestFree + 10) {
          best = cand;
          bestFree = free;
        }
      }
      u.lateralWant = best;
    }
  }
  const step = 2.6 * dt;
  u.lateral += clamp(u.lateralWant - u.lateral, -step, step);
}

function kinOf(veh: VehicleEntity): Kin {
  const h = veh.car.h.chassis.halfExtents;
  return { x: veh.car.body.translation().x, z: veh.car.body.translation().z, yaw: veh.car.yaw, speed: veh.car.speedForward, halfLen: h[2], halfWid: h[0] };
}

/** The pull of an active PIT: where to aim and how fast, or null when no PIT is on (starts one when it should). */
function pitStep(m: PoliceManager, u: Unit, veh: VehicleEntity, t: Target, dt: number): { aim: PathPoint; speed: number } | null {
  const R = POLICE_RULES.pit;
  const sim = m.sim;
  const cop = kinOf(veh);
  if (!u.pit) {
    if (!u.agency.pit || u.role !== 'chaser' || !t.kin || !t.veh) return null;
    if (sim.law.heat.level < R.minHeat || u.pitCool > 0 || u.grace > 0 || u.chaseT < 3 || u.ramming) return null;
    if (t.speed < R.targetSpeed[0] || t.speed > R.targetSpeed[1] || cop.speed < 5) return null;
    if (m.units.some((o) => o !== u && o.pit)) return null;
    const side = pitSide(cop, t.kin);
    const plan = planPit(cop, t.kin, side, R);
    // Behind the target's tail, within reach, on a straight run (the target is not turning hard).
    if (plan.long > -2 || plan.gap > 22 || Math.abs(m.tgt!.yawRate) > 0.5) return null;
    u.pit = { side, t: 0, alignT: 0, strikeT: 0, yaw0: t.kin.yaw, struck: false, hit: false };
    u.follower = null;
  }
  const p = u.pit!;
  if (!t.kin || !t.veh) {
    u.pit = null;
    return null;
  }
  p.t += dt;
  const plan = planPit(cop, t.kin, p.side, R, p.alignT >= R.warnS);
  const abort = (why: 'abort' | 'hit') => {
    if (why === 'hit') {
      u.grace = R.graceAfterHitS;
      m.stats.pitHits++;
      sim.emit({ type: 'police:pit', tick: sim.tick, vehicleId: veh.id, targetId: t.veh!.id, phase: 'hit' });
    } else if (p.struck) sim.emit({ type: 'police:pit', tick: sim.tick, vehicleId: veh.id, targetId: t.veh!.id, phase: 'abort' });
    u.pitCool = R.cooldownS;
    u.pit = null;
    u.follower = null;
    u.routeAge = 99;
    return null;
  };
  if (p.struck) {
    // The strike is on: it either turns the target (a hit) or it does not within a couple of seconds.
    p.strikeT += dt;
    if (Math.abs(wrapAngle(t.kin.yaw - p.yaw0)) > 0.5) return abort('hit');
    if (p.strikeT > 1.8) return abort('abort');
  }
  if (plan.phase === 'abort' || p.t > R.attemptS || t.speed < R.targetSpeed[0] * 0.8) return abort('abort');
  if (plan.phase === 'align') {
    // The unit runs alongside the rear quarter, visibly, before it commits.
    p.alignT += dt;
    return { aim: plan.aim, speed: plan.speed };
  }
  if (plan.phase === 'strike' && !p.struck) {
    p.struck = true;
    p.yaw0 = t.kin.yaw;
    m.stats.pitAttempts++;
    sim.emit({ type: 'police:pit', tick: sim.tick, vehicleId: veh.id, targetId: t.veh.id, phase: 'attempt' });
  }
  // The nose is on the quarter panel: the shove. The physics of two boxes sets the tail going; this makes it count.
  if (p.struck && !p.hit && plan.gap < 0.3 && plan.gap > -3.5 && plan.lat < kinOf(veh).halfWid + t.kin.halfWid + 0.3) {
    p.hit = true;
    t.veh.car.pitKick(p.side * R.contactSpin);
  }
  return { aim: plan.aim, speed: plan.speed };
}

/** Ramming (heat 4 and up): after the target at a few m/s over its speed until the cars touch. */
function ramStep(m: PoliceManager, u: Unit, veh: VehicleEntity, t: Target, dTarget: number, dt: number): { aim: PathPoint; speed: number } | null {
  const R = POLICE_RULES.ram;
  const sim = m.sim;
  if (!t.kin || !t.veh) return null;
  if (!u.ramming) {
    if (sim.law.heat.level < R.minHeat || u.ramCool > 0 || u.grace > 0 || u.pit || (u.role !== 'chaser' && u.role !== 'flanker')) return null;
    if (dTarget > R.rangeM || t.speed < 3 || u.chaseT < 2.5) return null;
    // Not from far behind a fast car: close enough in speed that it lands as a shove, not a launch.
    if (veh.car.speedForward < t.speed - 3) return null;
    u.ramming = true;
    u.ramClock = 0;
  }
  const cop = veh.car.pose();
  const touch = kinOf(veh).halfLen + t.kin.halfLen + 0.4;
  u.ramClock += dt;
  if (dTarget < touch + 0.3) {
    u.ramming = false;
    u.follower = null;
    u.routeAge = 99;
    u.ramCool = R.cooldownS;
    u.grace = R.graceAfterHitS;
    m.stats.rams++;
    sim.emit({ type: 'police:ram', tick: sim.tick, vehicleId: veh.id, targetId: t.veh.id });
    return null;
  }
  if (u.ramClock > 3 || dTarget > R.rangeM * 1.8) {
    u.ramming = false;
    u.follower = null;
    u.routeAge = 99;
    u.ramCool = R.cooldownS * 0.5;
    return null;
  }
  void cop;
  return { aim: { x: t.x, z: t.z }, speed: t.speed + R.maxPlayerSpeedAdvantage };
}

export function driveUnit(m: PoliceManager, u: Unit, veh: VehicleEntity, player: PedEntity, dt: number) {
  const sim = m.sim;
  const input = veh.input;
  // Someone else has taken the car (the player stole it): it is theirs to drive now.
  if (veh.owner !== AI_OWNER) {
    veh.lightbar = false;
    veh.siren = false;
    return;
  }
  const heat = sim.law.heat;
  const t = m.tgt;
  const chase = m.chases(u, player);
  const heatOn = !veh.burnt && heat.level > 0 && !(m.standingDown && u.leaveT > 12);

  // A roadblock car stands where it was put until the block is lifted.
  if (u.block) {
    veh.lightbar = heatOn;
    veh.siren = false;
    input.throttle = 0;
    input.brake = 0.3;
    input.steer = 0;
    input.handbrake = true;
    return;
  }

  const driver = veh.occupantId ? (sim.registry.get(veh.occupantId) as PedEntity | undefined) : undefined;
  const chasing = !m.standingDown && u.mode === 'drive' && !!t && chase && t.live;
  // Marked cars run their lights from the first call; an unmarked car's strobes come on only when it is chasing.
  veh.lightbar = u.agency.unmarked ? heatOn && chasing : heatOn;
  veh.siren = veh.lightbar && u.mode === 'drive';
  if (!driver || driver.role !== 'police' || driver.life !== 'alive' || veh.engineDead || veh.burnt) {
    input.throttle = 0;
    input.brake = 0.2;
    input.steer = 0;
    input.handbrake = true;
    return;
  }
  const car = veh.car;
  const pose = car.pose();
  const h = car.h;
  u.routeAge += dt;
  const cap = m.speedCap(u.agency);

  // ---- What to do, and where.
  let goal: PathPoint | null = null;
  let cruise: number = POLICE.respondSpeed;
  let stopAtEnd = true;
  let mode: UnitMode = u.mode;
  let avoid = null as ReturnType<typeof m.predicted>;
  let goalHeading: number | null = null;
  let ignore: VehicleEntity | null = null;
  let override: { aim: PathPoint; speed: number } | null = null;
  let parking = false;

  if (m.standingDown || u.mode === 'leave') {
    mode = 'leave';
    cruise = POLICE.leaveSpeed;
    if (!u.loiterGoal || u.routeAge > 30) {
      const far = m.graph.pickAround(m.rng, pose.x, pose.z, 150, 300, () => true, 8);
      u.loiterGoal = far ? { x: far.x, z: far.z } : null;
      u.follower = null;
    }
    goal = u.loiterGoal;
  } else {
    const dTarget = t ? Math.hypot(t.x - pose.x, t.z - pose.z) : Infinity;
    if (chase && t && !(!player.vehicleId && dTarget < 12)) {
      mode = 'drive';
      if (t.live) {
        u.chaseT += dt;
        u.searchGoal = null;
        goal = { x: t.x, z: t.z };
        if (t.inCar && player.vehicleId) {
          let role = u.role === 'responder' ? 'chaser' : u.role;
          const ahead = (pose.x - t.x) * Math.sin(t.heading) + (pose.z - t.z) * Math.cos(t.heading);
          if (role === 'blocker' && u.blockStage === 0 && ahead < 20) role = 'chaser';
          // Chasing a car: keep after it, no faster than is sensible when close.
          // (a heavy car closes gently: it has to be able to stop the closing speed by the time it is there)
          cruise = Math.min(cap, Math.max(6, t.speed + 3.5 + dTarget * 0.16));
          stopAtEnd = false;
          goalHeading = t.speed > 3 ? t.heading : null;
          if (role === 'blocker') {
            // Meet it ahead on its route, with time to spare.
            if (!u.meet || sim.tick / 60 - u.meetAt > 1) {
              const hit = m.meetPoint(u, veh, 5);
              u.meet = hit ? { x: hit.point.x, z: hit.point.z, s: hit.s, dx: hit.point.dx, dz: hit.point.dz } : u.blockStage > 0 ? u.meet : null;
              u.meetAt = sim.tick / 60;
            }
            if (u.meet) {
              goal = { x: u.meet.x, z: u.meet.z };
              goalHeading = Math.atan2(u.meet.dx, u.meet.dz);
              const dMeet = Math.hypot(u.meet.x - pose.x, u.meet.z - pose.z);
              stopAtEnd = true;
              cruise = dMeet < 45 ? Math.min(cruise, 9) : Math.min(cruise, cap);
              if (dMeet < 55 && u.blockStage === 0) {
                u.blockStage = 1;
                // The Highway Patrol lays a strip as it gets there, in front of the point it will block.
                if (u.agency.pursuit === 'aggressive' && !u.spikesLaid && sim.law.heat.level >= POLICE_RULES.spikes.minHeat) {
                  const route = m.predicted();
                  if (route) {
                    const sp = pointAlong(route, Math.max(8, u.meet.s - 14));
                    if (m.spikes.layAcross(sp.x, sp.z, sp.dx, sp.dz, 8)) u.spikesLaid = true;
                  }
                }
              }
              if (u.blockStage >= 1 && dMeet < 24) parking = true;
            } else {
              role = 'chaser';
              u.blockStage = 0;
            }
          } else if (role === 'flanker' && dTarget > 40) {
            if (!u.meet || sim.tick / 60 - u.meetAt > 1) {
              const hit = m.meetPoint(u, veh, -0.5);
              u.meet = hit ? { x: hit.point.x, z: hit.point.z, s: hit.s, dx: hit.point.dx, dz: hit.point.dz } : null;
              u.meetAt = sim.tick / 60;
            }
            if (u.meet) {
              goal = { x: u.meet.x, z: u.meet.z };
              goalHeading = Math.atan2(u.meet.dx, u.meet.dz);
              avoid = m.predicted();
              stopAtEnd = false;
            }
          }
          if (role === 'chaser' || role === 'flanker') {
            // From the ramming heat a chaser closes right up on the target (it brakes for anything else in its lane, not for the car it
            // is after): heavy cars that take a while to get back up to speed would otherwise hang back out of reach for good.
            if (role === 'chaser' && sim.law.heat.level >= POLICE_RULES.ram.minHeat && u.ramCool <= 0) ignore = t.veh;
            const near = dTarget < 45;
            if (near && (role === 'chaser' || dTarget < 40)) {
              override = pitStep(m, u, veh, t, dt) ?? ramStep(m, u, veh, t, dTarget, dt);
              if (override) ignore = t.veh;
            }
          }
        } else cruise = POLICE.respondSpeed;
      } else {
        // Lost them: go to where they were, then spread over the search area.
        u.chaseT = 0;
        u.pit = null;
        u.ramming = false;
        const lk = heat.lastKnown ?? heat.anchor;
        u.searchT -= dt;
        if (!u.searchGoal) {
          // (a car that got away is looked for down the road it took)
          const c = player.vehicleId ? m.searchCentre() : lk;
          u.searchGoal = c ? { x: c.x, z: c.z } : null;
        } else if (lk && (u.searchT <= 0 || (u.arrivedT > 1.6 && Math.hypot(u.searchGoal.x - pose.x, u.searchGoal.z - pose.z) < 14))) {
          const R = Math.max(40, Math.min(heat.searchRadius, 170));
          const p = m.graph.pickAround(m.rng, lk.x, lk.z, 0, R, () => true, 10);
          u.searchGoal = p ? { x: p.x, z: p.z } : { x: lk.x, z: lk.z };
          u.searchT = m.rng.range(8, 14);
        }
        goal = u.searchGoal ?? { x: t.x, z: t.z };
        cruise = Math.min(cap, 17);
      }
    } else {
      // Hold the scene: drive to it, then roam its streets.
      const anchor = heat.anchor ?? heat.lastKnown;
      if (!anchor) return;
      const dA = Math.hypot(anchor.x - pose.x, anchor.z - pose.z);
      if (dA > 35 && mode !== 'loiter') {
        mode = 'drive';
        goal = anchor;
      } else {
        mode = 'loiter';
        cruise = POLICE.loiterSpeed;
        u.loiterWait -= dt;
        const gd = u.loiterGoal ? Math.hypot(u.loiterGoal.x - pose.x, u.loiterGoal.z - pose.z) : 0;
        if (!u.loiterGoal || gd < 6) {
          if (u.loiterGoal && u.loiterWait <= 0) u.loiterWait = m.rng.range(2, 4);
          if (!u.loiterGoal || u.loiterWait <= 0) {
            const p = m.graph.pickAround(m.rng, anchor.x, anchor.z, 10, 60, () => true, 8);
            u.loiterGoal = p ? { x: p.x, z: p.z } : null;
            u.follower = null;
          }
        }
        goal = u.loiterGoal;
      }
    }
  }
  u.mode = mode === 'drive' || mode === 'loiter' || mode === 'leave' ? mode : u.mode;

  if (!goal) {
    input.throttle = 0;
    input.brake = 0.5;
    input.handbrake = true;
    return;
  }

  // ---- A route to the goal, replanned when it is old or the goal has moved.
  const moved = u.routeTo ? Math.hypot(u.routeTo.x - goal.x, u.routeTo.z - goal.z) : 1e9;
  // (at most a couple of A* searches a tick across all the units: a crowd of cars replanning together would be a hitch)
  if (!override && (!u.follower || u.follower.remaining < 3 || (u.routeAge > 1.2 && moved > 14) || u.routeAge > 6) && m.routeBudget > 0) {
    m.routeBudget--;
    const pts = m.nav.route({ x: pose.x, z: pose.z }, car.yaw, goal, { goalHeading, avoid });
    u.routeAge = 0;
    u.routeTo = { x: goal.x, z: goal.z };
    u.follower = pts && pts.length > 1 ? new PathFollower(pts) : null;
  }
  const f = u.follower;
  if (!f && !override) {
    input.throttle = 0;
    input.brake = 0.4;
    input.handbrake = true;
    return;
  }
  if (f) f.advance(pose.x, pose.z);
  // Arrived: close to where it was sent, or at the end of the road with the goal off the road.
  const dGoal = Math.hypot(goal.x - pose.x, goal.z - pose.z);
  if (mode === 'drive' && (dGoal < 18 || (f && f.remaining < 8 && Math.abs(car.speedForward) < 3))) u.arrivedT += dt;
  else if (mode === 'drive') u.arrivedT = 0;
  else if (mode === 'loiter') u.arrivedT += dt;

  // ---- Steering: pure pursuit on the path, aiming straight at the goal for the last stretch.
  const speed = car.speedForward;
  const wheelbase = h.wheels.frontZ - h.wheels.rearZ;
  const lock = steerLock(speed, h.steering);
  let aim: PathPoint;
  let steer: number;
  if (override) {
    aim = override.aim;
  } else {
    const look = lookaheadDistance(speed);
    aim = f!.lookahead(look);
    // The last stretch straight at the goal; for someone on foot from further out (a heavy car that overshoots a turn at the end
    // of its route would otherwise circle the block round them).
    const onFoot = player.vehicleId === 0;
    if ((f!.remaining < look + 4 || onFoot) && mode === 'drive' && dGoal < (onFoot ? 45 : 30) && sim.law.clearLine({ x: pose.x, y: pose.y + 0.6, z: pose.z }, { x: goal.x, y: pose.y + 0.6, z: goal.z })) aim = goal;
    // Take the next lane over when something slow is in this one.
    if (mode === 'drive' && !parking) {
      chooseLateral(m, u, veh, dt, ignore);
      if (Math.abs(u.lateral) > 0.05) {
        const k = f!.i;
        const a = f!.pts[Math.min(f!.pts.length - 1, k + 1)];
        const b = f!.pts[Math.min(f!.pts.length - 1, k + 3)];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        aim = { x: aim.x + (dz / l) * u.lateral, z: aim.z - (dx / l) * u.lateral };
      }
    } else u.lateral *= 0.9;
  }
  steer = steerCommand(pursuitAngle({ x: pose.x, z: pose.z, yaw: car.yaw, speed }, aim, wheelbase), lock);

  // ---- Speed: the governor on the path, cut for whatever is in the way.
  m.governor.cruise = cruise;
  m.governor.stopAtEnd = stopAtEnd;
  let target = override ? override.speed : f ? governSpeed(f, m.governor) : cruise;
  const wanted = target;
  u.ramT = Math.max(0, u.ramT - dt);
  const gap = clearAhead(m, veh, 0, 14, ignore);
  if (!override) target = u.ramT > 0 ? Math.min(target, 6) : Math.min(target, Math.max(0, gap - 4.5) * 1.6);
  else target = Math.min(target, cap + 8);
  if (mode === 'drive' && player.vehicleId === 0 && dGoal < 26) target = Math.min(target, Math.max(3, (dGoal - 10) * 0.6));

  // ---- A blocker parking across the road: turn in once slow, then hold.
  if (parking && u.meet) {
    const dir = Math.atan2(u.meet.dx, u.meet.dz);
    const yawErr = wrapAngle(car.yaw - dir);
    if (u.blockStage === 1 && Math.abs(yawErr) > 1.0) u.blockStage = 2;
    if (u.blockStage === 2) {
      input.throttle = 0;
      input.brake = 1;
      input.steer = 0;
      input.handbrake = true;
      return;
    }
    // Slowly round the corner of the lane: full lock toward the side it is already leaning to (right by default).
    const side = yawErr >= 0.05 ? 1 : yawErr <= -0.05 ? -1 : u.id % 2 === 0 ? 1 : -1;
    input.throttle = speed < 4 ? 0.35 : 0;
    input.brake = speed > 6 ? 0.5 : 0;
    input.steer = side;
    input.handbrake = false;
    return;
  }

  // ---- Stuck: wheels against something. Back out with the wheel the other way.
  if (u.reverseT > 0) {
    u.reverseT -= dt;
    input.throttle = 0;
    input.brake = 1;
    input.steer = u.reverseSteer;
    input.handbrake = false;
    // Brake input reverses once stopped.
    return;
  }
  pedalsFor(target, speed, tmpPedals);
  input.throttle = tmpPedals.throttle;
  input.brake = tmpPedals.brake;
  input.steer = steer;
  input.handbrake = false;
  // Stuck: it wants to go and is not going (against a wall, or boxed in by a car). Back out, and if that
  // does not help, push through.
  if (Math.abs(speed) < 0.6 && wanted > 2.5) u.stuckT += dt;
  else u.stuckT = Math.max(0, u.stuckT - dt * 2);
  if (u.stuckT > 1.6) {
    u.stuckT = 0;
    u.reverseT = 1.3;
    // Back out with the wheel toward whatever the nose is against, so the nose swings away from it (a heavy car will not shove a pole).
    const leftGap = clearAhead(m, veh, 0.75, 4);
    const rightGap = clearAhead(m, veh, -0.75, 4);
    u.reverseSteer = Math.abs(leftGap - rightGap) > 0.2 ? (rightGap < leftGap ? 1 : -1) : u.stuckCycles % 2 === 0 ? 1 : -1;
    u.follower = null;
    u.routeAge = 99;
    if (++u.stuckCycles >= 2) {
      u.ramT = 5;
      u.stuckCycles = 0;
    }
  }
}
