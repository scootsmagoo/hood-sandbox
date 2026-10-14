/**
 * Shared by the browser checks and the screenshot scripts: reading the game's state and walking the
 * character to a point with REAL key presses (so every DOM listener runs).
 */

/** Runs in the page. The state of the world as the player sees it. */
export const STATE = () => {
  const g = window.__hood.game;
  const v = g.view;
  const yawOf = (q) => Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
  const cars = [];
  const peds = [];
  for (const e of v.entities.values()) {
    const def = v.defs.get(e.id);
    if (e.kind === 2) cars.push({ id: e.id, type: def?.typeId, x: e.x, y: e.y, z: e.z, fwd: e.speed, speed: Math.hypot(e.vx, e.vz), yaw: yawOf(e.q), flags: e.flags, wheels: Array.from(e.wheels) });
    else peds.push({ id: e.id, x: e.x, y: e.y, z: e.z, speed: e.speed, flags: e.flags, player: !!def?.player });
  }
  const car = v.vehicle;
  return {
    inCar: v.inVehicle,
    ped: { x: v.ped.x, y: v.ped.y, z: v.ped.z, speed: v.ped.speed, flags: v.ped.flags },
    car: car && { id: car.id, type: v.defs.get(car.id)?.typeId, x: car.x, y: car.y, z: car.z, fwd: car.speed, speed: Math.hypot(car.vx, car.vz), yaw: yawOf(car.q), flags: car.flags },
    cars,
    peds,
    prompt: document.querySelector('.hud-prompt')?.textContent ?? '',
    camYaw: g.cameraRig.yaw,
    preset: g.cameraRig.preset,
    tick: v.tick,
  };
};

/** World position of a point in a car's frame (+Z forward, +X left). */
export const carPoint = (car, lx, lz) => ({
  x: car.x + Math.cos(car.yaw) * lx + Math.sin(car.yaw) * lz,
  z: car.z - Math.sin(car.yaw) * lx + Math.cos(car.yaw) * lz,
});

/** Where to stand to work a car's driver door. */
export async function doorStand(page, car) {
  const g = await page.evaluate((t) => window.__hood.doors(t), car.type);
  return carPoint(car, g.stand.x, g.stand.z);
}

/**
 * Walks the character toward a point with W A S D (camera-relative), until within `tol` metres.
 * `target(state)` returns the point, so it can follow a moving thing. `via` is a list of waypoints
 * visited first (to go round a car rather than through it).
 */
export async function walkTo(page, target, { tol = 0.7, timeoutMs = 20000, sprint = false } = {}) {
  const held = new Set();
  const set = async (key, on) => {
    if (on && !held.has(key)) { await page.keyboard.down(key); held.add(key); }
    else if (!on && held.has(key)) { await page.keyboard.up(key); held.delete(key); }
  };
  const t0 = Date.now();
  let s;
  try {
    for (;;) {
      s = await page.evaluate(STATE);
      const goal = await target(s);
      const dx = goal.x - s.ped.x;
      const dz = goal.z - s.ped.z;
      const d = Math.hypot(dx, dz);
      if (d < tol) return { ok: true, state: s, dist: d };
      if (Date.now() - t0 > timeoutMs) return { ok: false, state: s, dist: d };
      const ux = dx / d;
      const uz = dz / d;
      const f = ux * -Math.sin(s.camYaw) + uz * -Math.cos(s.camYaw);
      const r = ux * Math.cos(s.camYaw) + uz * -Math.sin(s.camYaw);
      await set('KeyW', f > 0.3);
      await set('KeyS', f < -0.3);
      await set('KeyD', r > 0.3);
      await set('KeyA', r < -0.3);
      await set('ShiftLeft', sprint && d > 3);
      await page.waitForTimeout(40);
    }
  } finally {
    for (const k of [...held]) await set(k, false);
  }
}

/** Runs in the page. What the HUD shows for health, armour and the law. */
export const HUD = () => {
  const stars = document.querySelector('.hud-stars');
  const star0 = stars?.querySelector('.star polygon');
  const css = star0 ? getComputedStyle(star0) : null;
  const pct = (sel) => parseFloat(document.querySelector(sel)?.style.width ?? '0');
  const overlay = document.querySelector('.hud-overlay');
  return {
    heat: Number(stars?.dataset.heat ?? 0),
    phase: stars?.dataset.phase ?? 'none',
    starsVisible: !!stars?.classList.contains('active'),
    /** The first star's fill: transparent while only reported, solid once seen. */
    starFill: css?.fill ?? '',
    starFillOpacity: css ? Number(css.fillOpacity) : 1,
    health: pct('.bar.health .fill'),
    armour: pct('.bar.armour .fill'),
    overlay: overlay?.classList.contains('on') ? (overlay.querySelector('.text')?.textContent ?? '') : '',
  };
};

/** Runs in the page with loopback transport: the live simulation, for setting a scene up. */
export const SIM = '(window.__hood.game.transport.host.simulation)';
