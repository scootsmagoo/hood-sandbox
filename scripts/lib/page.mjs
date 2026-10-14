/**
 * Code that runs INSIDE the game page for the perf, soak and leak harnesses. Playwright sends
 * `installHarness` to the page as source text, so it must not use anything outside itself.
 *
 * It adds `window.__h` with:
 *   bot   a scripted player. It plays the real game through the real input path (the analog move
 *         and the E key), following the real road centrelines of the tile (roads.json), so the sim,
 *         the camera and the streaming all do what they do for a person.
 *           walkOutAndBack(m)  walk m metres out along the streets, then back the same way
 *           enterCar()         walk to the nearest car and press E
 *           drive(s)           drive a wandering route over the streets for s seconds
 *           parkAndExit()      brake to a stop and get out
 *           spin(s)            stand and turn the camera round once
 *   rec   a frame recorder: begin(name) ... end() gives the summary of a phase: animation-frame times, main-thread
 *         CPU ms per frame, GPU ms per frame (timer queries), draws, triangles, heap
 *   memory()  counts the harnesses watch: renderer geometries (and `unusedGeometries`, the uploaded ones the scene
 *             no longer draws: the leak signal), textures, programs, scene objects
 */
export function installHarness(cfg) {
  const hood = window.__hood;
  const game = hood.game;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // the car's yaw: it drives toward (sin yaw, cos yaw), unlike the camera, which looks toward (-sin yaw, -cos yaw)
  const yawOf = (q) => Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
  let seed = (cfg && cfg.seed) || 1;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- the street graph
  const SKIP = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'service', 'busway', 'track', 'path']);
  const nodes = new Map(); // key -> { x, z, out: directed edges }
  let edgeCount = 0;
  const key = (x, z) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
  const nodeAt = (x, z) => {
    const k = key(x, z);
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { k, x, z, out: [] }));
    return n;
  };
  const ready = (async () => {
    const tileParam = new URLSearchParams(location.search).get('tile') ?? 'tiles/atlanta/m1-five-points/';
    const res = await fetch(new URL('roads.json', new URL(tileParam, document.baseURI)));
    if (!res.ok) throw new Error('roads.json: HTTP ' + res.status);
    const { roads } = await res.json();
    for (const r of roads) {
      if (SKIP.has(r.class) || r.bridge || r.points.length < 2) continue;
      const pts = r.points.map((p) => ({ x: p[0], z: p[2] }));
      const a = nodeAt(pts[0].x, pts[0].z);
      const b = nodeAt(pts[pts.length - 1].x, pts[pts.length - 1].z);
      if (a === b) continue;
      const id = edgeCount++;
      // A car cannot climb a street that the ground mesh drapes over a trench: more than an 18 % grade
      // between two points is a map artefact, so cars keep off it (people can walk it).
      let steep = false;
      for (let i = 1; i < r.points.length; i++) {
        const a2 = r.points[i - 1], b2 = r.points[i];
        const run = Math.hypot(b2[0] - a2[0], b2[2] - a2[2]);
        if (run > 2 && Math.abs(b2[1] - a2[1]) / run > 0.18) steep = true;
      }
      a.out.push({ id, pts, from: a, to: b, walkOnly: steep, rev: id + 0.5 });
      b.out.push({ id: id + 0.5, pts: pts.slice().reverse(), from: b, to: a, walkOnly: steep || !!r.oneway, rev: id });
    }
  })();

  /** The straight-line points of `pts`, with a point at least every 3 m. */
  const densify = (pts) => {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(d / 3));
      for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    return out;
  };

  /** Places the car got wedged at (a street under a bridge that the ground mesh covers, a barrier): routes steer clear. */
  const bad = [];
  const nearBad = (x, z, r) => bad.some((b) => Math.hypot(b.x - x, b.z - z) < r);

  /** A path that starts on the street nearest (x, z) and heads about `heading` (or any way). */
  function startPath(x, z, heading, mode) {
    let best = null;
    for (const n of nodes.values()) {
      for (const e of n.out) {
        if (mode === 'drive' && e.walkOnly) continue;
        for (let i = 0; i < e.pts.length - 1; i++) {
          const a = e.pts[i], b = e.pts[i + 1];
          const dx = b.x - a.x, dz = b.z - a.z;
          const l2 = dx * dx + dz * dz || 1;
          const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1);
          const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
          let cost = d;
          if (heading !== undefined) cost += 12 * Math.abs(wrap(Math.atan2(-dx, -dz) - heading));
          if (bad.length && nearBad(a.x + dx * t, a.z + dz * t, 25)) cost += 80;
          if (!best || cost < best.cost) best = { cost, e, i, t, x: a.x + dx * t, z: a.z + dz * t };
        }
      }
    }
    if (!best) throw new Error('no streets');
    const pts = [{ x, z }, { x: best.x, z: best.z }, ...best.e.pts.slice(best.i + 1)];
    return { pts: densify(pts), last: best.e, i: 0 };
  }

  /** Appends the next street at the end of a path: the straightest way on, pulled back toward home when far. */
  function extend(p, mode) {
    const node = p.last.to;
    let cands = node.out.filter((e) => (mode === 'drive' ? !e.walkOnly : true) && e.id !== p.last.rev);
    if (!cands.length) cands = node.out.filter((e) => mode === 'drive' ? !e.walkOnly : true);
    if (!cands.length) return false;
    const inA = p.pts[p.pts.length - 1], inB = p.pts[Math.max(0, p.pts.length - 3)];
    const inHeading = Math.atan2(-(inA.x - inB.x), -(inA.z - inB.z));
    const far = Math.hypot(node.x, node.z) > 420;
    let pick = null;
    const clean = cands.filter((e) => !e.pts.some((q) => nearBad(q.x, q.z, 20)));
    if (clean.length) cands = clean;
    for (const e of cands) {
      const a = e.pts[0], b = e.pts[Math.min(2, e.pts.length - 1)];
      const h = Math.atan2(-(b.x - a.x), -(b.z - a.z));
      const turn = Math.abs(wrap(h - inHeading));
      let score = -turn + rnd() * 0.9;
      if (far) {
        const end = e.pts[e.pts.length - 1];
        score += (Math.hypot(node.x, node.z) - Math.hypot(end.x, end.z)) * 0.02;
      }
      if (!pick || score > pick.score) pick = { e, score };
    }
    p.pts.push(...densify(pick.e.pts).slice(1));
    p.last = pick.e;
    return true;
  }

  /** Pure pursuit along a path: `i` is the progress, the target is `look` metres ahead of it. */
  function follow(p, x, z, look) {
    let bi = p.i, bd = Infinity;
    for (let i = p.i; i < Math.min(p.pts.length, p.i + 25); i++) {
      const d = Math.hypot(p.pts[i].x - x, p.pts[i].z - z);
      if (d < bd) { bd = d; bi = i; }
    }
    p.i = bi;
    let acc = 0, j = bi;
    while (j < p.pts.length - 1 && acc < look) {
      acc += Math.hypot(p.pts[j + 1].x - p.pts[j].x, p.pts[j + 1].z - p.pts[j].z);
      j++;
    }
    return { x: p.pts[j].x, z: p.pts[j].z, done: j >= p.pts.length - 1 && acc < look };
  }

  // ---------------------------------------------------------------- the bot
  const input = game.input;
  const bot = {
    mode: 'idle',
    stuck: 0,
    stuckResets: 0,
    path: null,
    out: 0,
    resolve: null,
    until: 0,
    spinFrom: 0,
    spinMs: 0,
    tapAt: 0,
    kills: 0,
    stats: { driven: 0, walked: 0, enters: 0, exits: 0, stuckEvents: 0, reroutes: 0 },
  };
  const finish = () => {
    const r = bot.resolve;
    bot.resolve = null;
    bot.mode = 'idle';
    input.setAnalogMove('bot', 0, 0);
    if (r) r();
  };
  const go = (mode) => new Promise((resolve) => { bot.mode = mode; bot.resolve = resolve; bot.stuck = 0; });
  const tapE = () => {
    const now = performance.now();
    if (now - bot.tapAt < 700) return;
    bot.tapAt = now;
    input.simulate('KeyE', true);
    setTimeout(() => input.simulate('KeyE', false), 90);
  };
  const lastPos = { x: 0, z: 0, t: 0 };

  game.addSystem({
    name: 'bot',
    priority: 5,
    update(dt) {
      const v = game.view;
      if (!v || !v.controlled) return;
      const now = performance.now();
      const st = v.controlled;
      const moved = Math.hypot(st.x - lastPos.x, st.z - lastPos.z);
      if (now - lastPos.t > 500) {
        bot.stuck = moved < 0.35 && (bot.mode === 'walk' || bot.mode === 'drive' || bot.mode === 'toCar') ? bot.stuck + 1 : 0;
        lastPos.x = st.x; lastPos.z = st.z; lastPos.t = now;
      }
      switch (bot.mode) {
        case 'walk': {
          // out `bot.out` metres, then back along the same street
          const p = bot.path;
          const t = follow(p, st.x, st.z, 5);
          game.cameraRig.yaw = Math.atan2(-(t.x - st.x), -(t.z - st.z));
          input.setAnalogMove('bot', 0, -1);
          bot.stats.walked += st.speed * dt;
          if (t.done || bot.stuck > 12) {
            if (!p.back && bot.stuck <= 12) {
              p.pts = p.pts.slice().reverse();
              p.i = 0;
              p.back = true;
            } else finish();
          }
          break;
        }
        case 'toCar': {
          // Back to where we got out (or started): E works there. (Where the door is, and who sits
          // in the car, is the sim's business and changes; a spot that worked once keeps working.)
          const home = bot.home || st;
          const d = Math.hypot(home.x - st.x, home.z - st.z);
          game.cameraRig.yaw = Math.atan2(-(home.x - st.x), -(home.z - st.z));
          if (v.inVehicle) finish();
          else {
            input.setAnalogMove('bot', 0, d > 0.8 ? -1 : 0);
            if (d < 2.5) tapE();
          }
          break;
        }
        case 'drive': {
          if (!v.inVehicle) { finish(); break; }
          const yaw = yawOf(st.q);
          const fwd = st.speed;
          const abs = Math.hypot(st.vx, st.vz);
          if (!bot.path) bot.path = startPath(st.x, st.z, yaw + Math.PI, 'drive');
          const p = bot.path;
          if (p.pts.length - p.i < 40 && !extend(p, 'drive')) bot.path = null;
          if (p.i > 300) { p.pts.splice(0, p.i - 20); p.i = 20; }
          if (bot.reverseUntil && now < bot.reverseUntil) {
            input.setAnalogMove('bot', bot.reverseSteer, 1, true);
            break;
          }
          if (bot.stuck >= 5) {
            // wedged: back out for a moment, and take another street after a few tries
            bot.stats.stuckEvents++;
            bot.stuck = 0;
            bot.reverseUntil = now + 1600;
            bot.reverseSteer = rnd() < 0.5 ? -1 : 1;
            // Remember the spot and take another street (after backing out of it).
            if (!nearBad(st.x, st.z, 10)) bad.push({ x: st.x, z: st.z });
            if (++bot.stuckResets % 2 === 0) { bot.path = null; bot.stats.reroutes++; }
            break;
          }
          const t = follow(p, st.x, st.z, 7 + abs * 0.7);
          const err = wrap(Math.atan2(t.x - st.x, t.z - st.z) - yaw);
          const steer = clamp(-err * 1.6, -1, 1);
          const want = clamp(13 - 11 * Math.min(1, Math.abs(err) / 0.7), 3.5, 13);
          const accel = clamp((want - fwd) * 0.45, -1, 1);
          input.setAnalogMove('bot', steer, -accel, true);
          bot.stats.driven += abs * dt;
          if (now > bot.until) finish();
          break;
        }
        case 'park': {
          const abs = Math.hypot(st.vx, st.vz);
          if (!v.inVehicle) {
            bot.stats.exits++;
            bot.home = { x: st.x, z: st.z };
            finish();
            break;
          }
          input.setAnalogMove('bot', 0, abs > 0.6 ? 1 : 0, true);
          if (abs < 0.8) tapE();
          break;
        }
        case 'spin': {
          const f = clamp((now - bot.spinFrom) / bot.spinMs, 0, 1);
          game.cameraRig.yaw = bot.spinYaw0 + f * Math.PI * 2;
          if (f >= 1) finish();
          break;
        }
      }
    },
  });

  bot.walkOutAndBack = async (metres) => {
    await ready;
    const v = game.view.controlled;
    bot.home = { x: v.x, z: v.z };
    const p = startPath(v.x, v.z, undefined, 'walk');
    // extend until long enough
    const len = () => p.pts.reduce((a, q, i) => (i ? a + Math.hypot(q.x - p.pts[i - 1].x, q.z - p.pts[i - 1].z) : 0), 0);
    let guard = 0;
    while (len() < metres && guard++ < 40 && extend(p, 'walk'));
    // cut it to the length asked for
    let acc = 0;
    for (let i = 1; i < p.pts.length; i++) {
      acc += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].z - p.pts[i - 1].z);
      if (acc >= metres) { p.pts.length = i + 1; break; }
    }
    p.i = 0;
    bot.path = p;
    await go('walk');
  };
  bot.enterCar = async () => {
    if (game.view.inVehicle) return;
    bot.stats.enters++;
    await go('toCar');
  };
  bot.drive = async (seconds) => {
    await ready;
    bot.path = null;
    bot.reverseUntil = 0;
    bot.until = performance.now() + seconds * 1000;
    await go('drive');
  };
  bot.parkAndExit = () => go('park');
  bot.spin = (seconds) => {
    bot.spinFrom = performance.now();
    bot.spinMs = seconds * 1000;
    bot.spinYaw0 = game.cameraRig.yaw;
    return go('spin');
  };
  bot.stop = () => finish();
  bot.ready = ready;

  // ---------------------------------------------------------------- the frame recorder
  const rec = { cur: null, done: {} };
  // GPU time of each frame's render call (EXT_disjoint_timer_query_webgl2), read back a few frames late.
  // Timer queries cost a little themselves and are not everywhere (Safari has none): gpu is null then.
  const gl = game.renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending = [];
  const gpuMs = [];
  if (timer) {
    const render = game.renderer.render.bind(game.renderer);
    game.renderer.render = (scene, camera) => {
      if (pending.length > 8) { render(scene, camera); return; }
      const q = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
      render(scene, camera);
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push(q);
    };
  }
  const readGpu = () => {
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = pending.shift();
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  };
  let lastT = performance.now();
  let lastFrame = game.frame;
  const loop = (t) => {
    requestAnimationFrame(loop);
    if (timer) readGpu();
    const dt = t - lastT;
    lastT = t;
    const c = rec.cur;
    if (!c || game.frame === lastFrame) { lastFrame = game.frame; return; }
    lastFrame = game.frame;
    const info = game.renderer.info;
    c.dt.push(dt);
    c.cpu.push(game.cpuMs);
    c.calls = Math.max(c.calls, info.render.calls);
    c.tris = Math.max(c.tris, info.render.triangles);
    c.callsSum += info.render.calls;
    const s = game.transport.stats;
    if (s) c.stepMax = Math.max(c.stepMax, s.stepMaxMs);
  };
  requestAnimationFrame(loop);
  const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
  rec.begin = (name) => {
    gpuMs.length = 0;
    rec.cur = { name, dt: [], cpu: [], calls: 0, callsSum: 0, tris: 0, stepMax: 0, t0: performance.now() };
  };
  rec.end = () => {
    const c = rec.cur;
    rec.cur = null;
    if (!c) return null;
    const dt = c.dt.slice().sort((a, b) => a - b);
    const cpu = c.cpu.slice().sort((a, b) => a - b);
    const mem = performance.memory;
    const gpu = gpuMs.slice().sort((a, b) => a - b);
    const out = {
      name: c.name,
      seconds: +((performance.now() - c.t0) / 1000).toFixed(1),
      frames: dt.length,
      frameP50: +pct(dt, 0.5).toFixed(2),
      frameP95: +pct(dt, 0.95).toFixed(2),
      frameMax: +(dt[dt.length - 1] || 0).toFixed(1),
      slowFrames: dt.filter((d) => d > 33.4).length,
      cpuMean: +(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)).toFixed(2),
      cpuP95: +pct(cpu, 0.95).toFixed(2),
      gpuP50: gpu.length ? +pct(gpu, 0.5).toFixed(2) : null,
      gpuP95: gpu.length ? +pct(gpu, 0.95).toFixed(2) : null,
      draws: c.calls,
      drawsMean: Math.round(c.callsSum / Math.max(1, dt.length)),
      triangles: c.tris,
      simStepMax: +c.stepMax.toFixed(2),
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
    };
    rec.done[c.name] = out;
    return out;
  };

  // ---------------------------------------------------------------- memory counts
  // three.js uploads a geometry the first time it draws it, and frees it only on dispose(). So the raw
  // count grows whenever the camera first sees a chunk (expected, once) and only a geometry that is
  // uploaded and then left out of the scene without dispose() is a leak. `drawn` is every geometry that
  // has gone through renderBufferDirect (every draw, shadow passes included) since the harness was
  // installed; `unusedGeometries` = the geometries the renderer holds minus the drawn ones still in the
  // scene. Its growth is the leak signal. (Geometries drawn only before the install are a constant offset.)
  const drawn = new Set();
  const realDraw = game.renderer.renderBufferDirect;
  game.renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    drawn.add(geometry.uuid);
    return realDraw.call(this, camera, scene, geometry, material, object, group);
  };
  const memory = () => {
    const g = game;
    let objects = 0;
    const mats = new Set();
    const sceneGeos = new Set();
    g.scene.traverse((o) => {
      objects++;
      if (o.geometry) sceneGeos.add(o.geometry.uuid);
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m.uuid);
    });
    let usedGeos = 0;
    for (const u of sceneGeos) if (drawn.has(u)) usedGeos++;
    const info = g.renderer.info;
    const mem = performance.memory;
    return {
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      geometries: info.memory.geometries,
      unusedGeometries: info.memory.geometries - usedGeos,
      sceneGeometries: sceneGeos.size,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      materials: mats.size,
      objects,
      entities: g.view && g.view.entities ? g.view.entities.size : 0,
      tier: g.tier.name,
      fps: Math.round(g.fps),
    };
  };

  window.__h = { bot, rec, memory, ready, sleep };
  return true;
}
