# Performance: numbers and how to measure

Targets (README, "Performance and devices"): 60 fps on an M-series MacBook in Chrome and Safari, 30+ fps on an iPhone 15 Pro, about 1,500 draw calls and 3M visible triangles at most on High.

All numbers below are from the dev box (Linux, AMD Radeon 8060S through Vulkan, headless Chromium 1243/1248, Playwright 1.64) on 2026-10-14. That GPU is far faster than any phone, so **the GPU numbers are floors, not predictions**; the draw-call and triangle counts are exact and carry over to any device. See "Only on the real devices" at the end.

## What changed in this pass

| | Before | After |
|---|---|---|
| Ground | 1 mesh, 500k triangles, never culled | 8 x 8 chunks of 256 m, 2 levels of detail each, frustum-culled |
| Roads and buildings | 1 mesh per material | 1 mesh per chunk and material, frustum-culled |
| Rapier WASM | 4.4 MB base64 inside the sim worker **and** inside the loopback transport chunk | one 3.3 MB `.wasm` asset, streamed, shared by both |
| Low tier | no shadows, pixel ratio 1, far 700 m | the same, plus the coarse ground sooner (220 m, not 400 m), multisampling off, chunk culling |

### Scene cost, same scripted route (Downtown walk and drive, Chromium, 1280x720)

"Before" is a tile baked as one chunk (`chunkSizeM` 2048), which is exactly the old single-mesh structure. Draws and triangles count every pass (shadows included) and are the maximum over the phase.

| Profile, phase | Draws before -> after | Triangles before -> after | CPU ms/frame before -> after | GPU ms (p50) before -> after |
|---|---|---|---|---|
| desktop-high, walk | 243 -> 422 | 696k -> 171k | 0.84 -> 0.84 | 0.31 -> 0.24 |
| desktop-high, drive | 244 -> 431 | 696k -> 175k | 0.77 -> 0.81 | 0.30 -> 0.34 |
| desktop-low, walk | 135 -> 260 | 670k -> 109k | 0.44 -> 0.62 | 0.56 -> 0.25 |
| desktop-low, drive | 136 -> 274 | 670k -> 112k | 0.32 -> 0.59 | 0.53 -> 0.25 |
| phone-low (4x CPU), walk | - | 72k | 1.0 | - |
| phone-low (4x CPU), drive | - | 82k | 1.0 | - |

Triangles fall 4 to 6 times; draw calls roughly double (every chunk's material is its own draw, and the shadow pass draws the building chunks again). That trade is right for phones' GPUs and fill rate, and 430 draws on High is a third of the 1,500 budget, but **draw calls are the number to watch as peds, cars and props arrive** (see "Next" below for a cheap way to cut about a quarter of them). Frame time is 16.7 ms (display-bound) in every phase and profile on this box; at 1 ms of CPU and under 0.5 ms of GPU there is no pressure here, which is why the budgets are set from counts and the CPU/GPU ms are only tripwires.

Simple measure on the old tile before any change (one frame, shadows on): High 42 draws and 690k triangles; Low 19 draws and 666k triangles.

### Bundle (`npm run build`)

| File | Before | After |
|---|---|---|
| sim worker (`worker-*.js`) | 4,649,115 B (gzip 1,666,165) | 273,417 B (gzip 58,733) |
| loopback transport chunk (lazy fallback) | 4,640,557 B (gzip 1,662,516) | 262,298 B (gzip 54,161) |
| main chunk (`index-*.js`) | 697,275 B (gzip 180,526) | 704,215 B (gzip 183,511) |
| `rapier_wasm3d_bg-*.wasm` | inline, twice | 3,292,228 B (gzip 1,147,302), once, streamed |
| JS and WASM, all files | 9.99 MB (gzip 3.51 MB) | 4.53 MB (gzip 1.44 MB) |
| First load (main + worker + wasm) | 5.35 MB (gzip 1.85 MB) | 4.27 MB (gzip 1.39 MB) |

How: `@dimforge/rapier3d-simd-compat` ships the raw `rapier_wasm3d_bg.wasm` next to its JS, but its `exports` map hides it. The `rapierExternalWasm` plugin in `vite.config.ts` (main build and worker build) rewrites the single call that decodes the base64 string into a `?url` import of that file, so Vite emits it once as a hashed asset and Rapier `fetch`es and stream-compiles it. It throws if a future Rapier changes that call. The non-compat `@dimforge/rapier3d(-simd)` packages would need `vite-plugin-wasm` and top-level await; the plugin is smaller and works under COOP/COEP (the `.wasm` is same-origin). Tests and Node keep using the inline build untouched.

### Tile size

| | Before | After |
|---|---|---|
| `ground.glb` | 1.50 MB | 1.32 MB (both levels of detail) |
| `roads.glb` | 0.73 MB | 1.31 MB |
| `buildings.glb` | 0.21 MB | 0.50 MB |
| whole tile | 5.29 MB | 5.69 MB (limit 15 MB) |

Splitting costs about 0.8 MB because every chunk-material mesh has its own accessors and meshopt streams. If it matters, bigger chunks for roads and buildings (they are cheap to cull) or merging materials would win it back.

### Roads pass (junction polygons, markings, profiles), 2026-10-14

Same scripted route, before = the tile above, after = the tile with road profiles, junction polygons and markings (one `road_markings` mesh per chunk, drawn only within 320 m x lodScale of the camera; the old crosswalk ribbons are gone). Maximum over each phase:

| Profile, phase | Draws before -> after | Triangles before -> after |
|---|---|---|
| desktop-high, idle | 373 -> 361 | 153k -> 173k |
| desktop-high, walk | 422 -> 383 | 171k -> 192k |
| desktop-high, drive | 431 -> 427 | 175k -> 195k |
| desktop-high, look | 494 -> 461 | 207k -> 224k |
| desktop-low, idle | 211 -> 200 | 95k -> 109k |
| desktop-low, drive | 272 -> 253 | 112k -> 128k |

Draw calls do not grow (markings add one draw per visible chunk, and take away the crosswalk ribbon draws; the route differs a little from run to run). Triangles grow by 10 to 15%. The tile grows from 5.7 MB to 7.3 MB (`roads.glb` 1.3 -> 2.0 MB for the markings, junction surfaces and the bridges the pipeline made; `junctions.json` 0.9 MB, 0.15 MB gzipped; `collision.bin` 1.40 -> 1.72 MB for the derived bridges).

## Ambient pedestrians (2026-10-15)

What a crowd costs, measured on the same tree with `?ambient=0` against the default (traffic, lighting and everything else the same in both). Maximum over each phase; the route differs a little between runs, so draw counts move by up to 100 either way and mean nothing below that.

| Profile | People | Triangles, no peds -> peds | Draws | Main-thread CPU, mean | Sim step, worst |
|---|---|---|---|---|---|
| desktop-high | 60 | 234-267k -> 256-283k (+15 to +25k, 6 to 10%) | 5 for the crowd, 5 more in the shadow pass; no change beyond the noise | within +-0.3 ms | 3.4 ms against 2.2 |
| desktop-medium | 40 | 210-236k -> 225-251k (+15k) | no change | within noise | 4.0 against 3.3 |
| desktop-low | 24 | 134-164k -> 139-168k (+4k) | no change | within noise | 3.5 against 2.7 |
| phone-low (4x CPU) | 24 | 98-124k -> 102-114k | no change | 2.2-2.5 against 2.0-2.5 ms | 3.0 against 2.1 |

How it stays cheap:

- **Drawing.** A per-ped model is thirteen meshes, so 60 people would have been about 800 draws. Everyone except the player and officers is drawn by `PedCrowd` (`src/client/render/PedCrowd.ts`): five instanced meshes (torso, head, arms, legs, cap), 192 people at most, one set of matrices a person per frame from the shared pose solver (`pedPose.ts`). Benches and bus stops are two more instanced meshes for the whole tile (`ScenarioProps.ts`). Nothing is allocated or disposed when people come and go (a swap-remove in the instance arrays), so churn cannot leak.
- **The sim.** A person near the player costs a character-controller step (27 us); 60 of them were 1.6 ms of a 1.8 ms tick in Node. People standing still, and walkers more than 46 m away, skip it (`PedController.glide`; the move keeps out of walls: see "Collision and stuck people"), which brings 60 people to 0.17 ms a tick on top of 0.24 for the rest of the sim. The ambient logic itself is 0.05 ms a tick.
- **The snapshot.** The director never fills the 256 entities: it keeps 28 slots free for police, traffic and the player, and counts every entity that is not one of its own.
- `blendEntity` found each entity in the snapshot by scanning (O(n^2) a frame with a crowd); `NetSystem` now passes the record index it is already at.

The budgets in `scripts/perf-budget.json` were re-baselined on 2026-10-15 from two runs of the whole tree with ambient people and ambient traffic on (the budgets from the roads pass did not hold any more: traffic and the time-of-day sky landed in the same days as the crowd, and 60 people are about a tenth of the new triangles and none of the new draws). Worst phase of each profile, budget now: desktop-high 800 draws, 370k triangles; desktop-medium 820, 330k; desktop-low 530, 220k; phone-low 420, 170k.

**The harnesses with a crowd about.** The soak (5 min, desktop-medium, people and traffic on) passes: heap 35.6 -> 35.7 MB, no GPU growth, 0 slow frames. `leaks` was failing in the `vehicle` and `reload` phases when cars and people started to come and go, because the street is part of the scene (a car is 30 scene objects and a few geometries) and the reload phase allows no growth at all. The harness now freezes the population (`pedBudget` and `traffic` through `transport.config`) in the phases that measure the tile, the player's car and the tier switches, fixes both in the URL so the tier switches do not move them, and freezes the game clock (`timescale=0`: the night sky's first draw at dusk looked like a leaked geometry). A new `crowd` phase fills and empties the street twelve times (the ped budget goes between none and 40) and must stay flat: geometries, materials and objects exactly, heap within 1.5 MB a cycle.

## Ambient traffic (2026-10-15)

What the cars and the signal heads cost, measured on the same tree with `?traffic=0` against the default (pedestrians, lighting and the rest the same in both; the signal heads are in both). Maximum over each phase, one run each; the route differs a little between runs.

| Profile | Cars | Draws, no traffic -> traffic | Triangles, no traffic -> traffic | Main-thread CPU, mean |
|---|---|---|---|---|
| desktop-high | 40 | 396-536 -> 423-554 (+18 to +41) | 214-265k -> 256-282k (+18 to +44k) | +0.1 to +0.2 ms (1.1-1.4 -> 1.2-1.4) |
| desktop-low | 20 | 225-387 -> 243-407 (+18 to +35) | 128-161k -> 139-167k (+6 to +11k) | +0.1 ms (0.8 -> 0.9) |

The sim side is small: 60 s of Downtown with 40 cars (7 of them physics cars) costs about 0.4 ms a tick in Node, with the ped crowd and police included (the soak's worst step was 5 ms, from the pedestrians and the physics). Cars farther than 80 m are spline followers: a speed integration and one `setNextKinematicTranslation` each.

How it stays cheap:

- **Drawing.** A full car model is 25 meshes, so 40 of them would have been a thousand draws and a model built and torn down for every car that came and went. Every traffic car is drawn by `TrafficInstances` (`src/client/render/TrafficInstances.ts`) instead: the stand-in model is merged once per vehicle type into six parts (paint, trim, glass, tail lamps, headlamps, wheel), each an InstancedMesh, with the paint, the brake lights and the headlamps set per instance and the four wheels as instances of their own, so they roll and steer. That is 6 draws per type in use (3 at most), 18 in the shadow pass on High. A car that smokes, burns or has a door open (or is no longer traffic: a carjacked one) gets a full model, and its meshes are disposed when it goes. The first version let cars within 46 m use full models and cost +250 draws in the drive phase and a scene-object count that wandered with the number of cars near the camera, which the `leaks` reload phase read as growth.
- **Signal heads.** 112 signalised junctions have 319 heads. They are drawn in 400 m chunks, two instanced meshes a chunk (pole, arm and housing in one geometry, 8-sided lamp discs), so the chunks behind the camera are culled; lamp colours change only when a phase changes.
- **The sim.** Spline followers keep a speed along a lane and write a pose; only the 16 nearest cars are physics cars. Cars far away and out of sight are removed, so the count never grows.
- **The snapshot.** A spline follower is an ordinary vehicle entity (36 words). Its driver is not: a far car has no ped entity, the driver ped is made when the car turns into a physics car and removed when it turns back, so 40 cars cost 40 + about 16 entities. Traffic keeps 40 entities free in the 256.

The budgets in `scripts/perf-budget.json` were re-baselined on 2026-10-15 from two runs of the whole tree (traffic, pedestrians, signal heads, time of day) with `--write-budget`: draws 620 -> 740, 590 -> 730, 430 -> 540 and 330 -> 430, triangles 300k -> 380k, 260k -> 330k, 190k -> 220k and 140k -> 170k (desktop-high, medium, low, phone-low). Traffic is about a fifth of that growth in draws and a third in triangles; the rest is the crowd, the lighting and the tile. `npm run perf-budget` and `perf-budget:phone` pass on them.

**Harnesses with traffic about.** The soak (desktop-medium, 5 min, traffic at 0.75) and `leaks` (every phase flat, `--traffic 0` to take the cars out) pass. The bot drives through the traffic; the cars dodge it, honk at it when it stops in a lane and are otherwise undisturbed.

`node scripts/traffic-shots.mjs` takes the traffic screenshots into `.shots/` (a busy street, a red-light queue, signal heads, a carjack at a light with real key presses).

## Gunfire (2026-10-15)

What the guns cost, measured with every pool full at once: 96 tracers, 16 muzzle flashes, 64 bullet holes, and the dust, spark and blood puffs, all alive in one frame (`GunFx.timeScale` set to 0.02 so nothing expires), aim camera up, against the same frame with the gun up and nothing fired. 1280 x 720, Chromium, frame-rate limit off, `graphics=high` and `low`.

| Tier | Draws | Triangles | Main-thread CPU, mean |
|---|---|---|---|
| high | 375 -> 384 (+9) | 176.9k -> 177.6k (+0.7k) | 0.67 -> 0.76 ms |
| low | 209 -> 218 (+9) | 116.7k -> 117.4k (+0.7k) | 0.45 -> 0.53 ms |

Idle (nothing in the air, no shots) the effects cost nothing: every pool is an `InstancedMesh` with `count = 0` and `visible = false`, or a point pool with nothing alive, so they draw no calls.

How it stays cheap and flat:

- **Pooled, built once.** `GunFx` (`src/client/render/GunFx.ts`) makes its three instanced meshes (a ring of 96 tracers, 16 flashes, 64 bullet holes) and three `SmokeSystem` point pools (dust, sparks, blood) at boot, before the first shot. A shot only writes into a ring slot: no object, geometry, material or texture is created or disposed while playing, so a long fight cannot grow the scene. The tracers and flashes are camera-facing quads; the holes lie on the surface hit and the oldest is overwritten.
- **No lights.** A muzzle flash is a glow sprite, not a point light: a light that came and went would change the shader programs and recompile them.
- **Guns on models.** The player and the officers have their own models (the crowd never carries a gun); a gun is one merged mesh per kind, made the first time it is drawn and shared by every model after.
- **The sim.** A shot is one Rapier ray per pellet (eight for the shotgun) and a lookup from the body that was hit to its entity, built once per tick when something fires. The weapon systems walk the peds twice a tick (timers and the post-step facing), a few microseconds. Reactions to gunfire skip anyone who is already running, hiding or fighting, so a burst of fifty shots costs a ray per newly frightened person, not per shot.
- **The snapshot.** A ped's record already had 16 free words (the wheel block cars use); the gun, aim, lock-on and cover state go there, so the snapshot did not grow.

`npm run leaks` has a new `gunfire` phase (30 cycles, 120 shots each, every weapon and every kind of hit, plus the aim camera and the reload and click sounds): geometries 548 -> 548, textures 6 -> 6, programs 34 -> 34, materials and scene objects exactly flat, heap 39.0 -> 39.2 MB. `npm run perf-budget` has a new `gunfire` phase (6 s standing with the gun up, 12 shots a second through the client's event path); its budgets are in `scripts/perf-budget.json`. Both feed the shots through the client's listeners (`game.net.listeners`) rather than asking the sim to shoot, because a real shot is a crime and brings the police, and the point of the phases is the client's pools.

## The police escalation (2026-10-15)

Roadblocks, spike strips, helicopters, roles, PIT, ramming and police gunfire (`src/sim/police/`, the models in `src/client/render/PoliceProps.ts`). None of it runs without heat, so the existing scripted routes (no crime) are the check that nothing leaked into the quiet game, and a separate scene measures what a response costs.

**The harnesses, no heat.** `npm run perf-budget` and `perf-budget:phone`: every draw, triangle, geometry and heap budget passes with the same margins as before (desktop-high worst phase 559 draws and 283k triangles against 740 and 380k; phone-low 326 and 128k against 430 and 170k). The only failures were timing tripwires (p95 of the main thread's frame cost) on a machine that other jobs were using: desktop-low `drive.cpuP95` 2.3 ms against 2.2 passed on a repeat (1.8), and phone-low `walk.cpuP95` 5.1 and 4.8 against 4.4 passed on a quiet machine (load 0.04, best of three: 2.4 ms). `npm run soak` (5 min, desktop-medium): PASS, heap 36.7 -> 36.9 MB (0.1 MB/min), cpu 4.64 -> 3.2 us per draw call (limit 7.5), 0 slow frames, geometries +13 raw (+0 unused). `npm run leaks`: PASS, all six phases flat (reload 223 -> 223 geometries, heap 36 -> 36.7 MB). A new `police` phase (`--phases police --query transport=loopback`, 20 cycles) makes a helicopter (rotor, beam, glow) and a spike strip and takes them away again: geometries 225 -> 225, objects 912 -> 912, materials and programs flat, heap 81 -> 80.8 MB.

**What a response costs** (real Downtown tile, ambient traffic 0.75 and 40 people, 60 s of a bot driving, in Node):

| Heat | Police `update` per tick (mean) | Whole sim step (mean / worst) | Entities |
|---|---|---|---|
| none | 0.025 ms | 0.67 / 5.3 ms | 80 |
| 3 (a helicopter, 2 roadblock cars, strips, 2 cars) | 0.075 ms | 0.80 / 6.2 ms | 85 |
| 5 (2 helicopters, 3 more cars, 2 roadblocks, rams and fire) | 0.100 ms | 1.02 / 5.4 ms | 104 |

The expensive parts are the A* searches (lane graph, up to four candidate goals each): at most two run a tick across all units (`PoliceManager.routeBudget`), which took the worst tick from 5.8 to 3.8 ms. Shooting is one ray and a loop over the civilians a tick per officer that is in sight.

**Drawing it** (desktop-high, night, a car on the street, heat 5 after 20 s: 5 police cars, 10 officers, 1 helicopter, 2 strips; in the browser, 90 frames):

| | No police | Heat 5 |
|---|---|---|
| desktop-high: draws / triangles / main-thread cpu | 327 / 232k / 1.25 ms | 606 / 217k / 1.85 ms |
| desktop-low: draws / triangles / main-thread cpu | 223 / 144k / 0.90 ms | 429 / 141k / 1.43 ms |

So a heat 5 response is about 280 draws on High and 200 on Low: a police car is a full 28-mesh stand-in model (traffic is instanced, the police are not, because each car flashes its own lightbar in its own livery), an officer on foot 13 meshes. Two things keep it from being worse: an officer seated in a car is not drawn once the car is 40 m away, and a police car's wheels, lamps and trim do not cast shadows of their own (the body does). The helicopter's beam is three additive cones and a disc, not a light, so it adds no shader variants. **Next:** draw police cars from the instanced path (a per-instance lightbar phase) and officers from the crowd's meshes when they are not carrying a gun.

**Snapshot.** The header grew from 16 to 24 words (96 bytes a snapshot) for the search area and the police counts; helicopters and spike strips are ordinary 36-word records.

## Collision and stuck people (2026-10-15)

What it costs for every drawn solid to be solid, and for nobody to stay in a wall. Real Five Points tile, in Node, 60 people and traffic at 0.75, the player walking, 1800 ticks, the same seed with and without the furniture (`lanes.json` heads and the benches and stops of `scenarios.json` taken out):

| | Without | With |
|---|---|---|
| Colliders for street furniture | 0 | 1150 (319 signal poles with their arms and lamp housings, 44 benches, 15 bus stops: 378 props) |
| `world.step()`, mean | 0.08 ms | 0.20 ms (+0.12 ms, 0.7% of a 16.7 ms tick) |
| Whole sim step, mean | 1.06 ms | 1.21 to 1.34 ms |
| Building the physics world | 150 ms | 170 to 260 ms (once) |

The rest of the new work, per tick: the unstick check is one capsule overlap and one footprint lookup for a tenth of the people each tick (a person every 0.1 s: about 6 queries a tick at 60 people); a person who glides makes two or three lookups in a grid of footprint outlines per move, no physics query (about 1 us); the width of a walk edge is measured once, the first time anyone walks it (9 capsule sweeps; 15 757 edges take 0.5 s if all were measured, spread over the first minutes); a lite person asks for the floor under their feet six times a second. `PhysicsWorld` holds a footprint index (5493 roof triangles, 6525 outline segments, built from `collision.bin` in a few ms). `npm run audit:collision` (below) runs 10 sim minutes in 30 to 40 s.

### `npm run audit:collision` (10 sim minutes of Downtown in Node)

`tests/audit/collision-audit.audit.ts`: the real tile, ambient people (budget 60) and traffic (0.75), a scripted player who walks the sidewalks, jumps to somewhere else every 90 s, fires a shot's worth of fear every 25 s and shoves four people every 40 s, so people run. Every 0.5 s it checks everybody on foot against the footprints (taken from `AUDIT_TRUTH`'s `collision.bin`, courtyards open) and counts people who tried to move and got no further than 0.6 m from where a 5 s window began. `AUDIT_TILE=<dir>` runs another tile, `AUDIT_MINUTES`, `AUDIT_SEED`, `AUDIT_OUT=<file>`, `AUDIT_TRACE=<pedId>` (a ped's state twice a second) tune it.

| Seeds 7, 11, 23 (10 sim minutes each) | Before (db7cc1a, the old tile) | After |
|---|---|---|
| People ever inside a footprint | 15, 9, 9 | 0, 0, 0 |
| Person-seconds inside | 363, 130, 268 | 0, 0, 0 |
| People standing at a wall (centre within 20 cm) | 15, 5, 12 | 0, 0, 0 |
| Stuck for 5 s or more (trying to move) | 6, 20, 6 | 0, 1, 2 |
| Safety-net fixes (`ped:unstuck` events) | none exist | 14, 4, 9 (the world's edge, where fleeing people run off the map; a pocket of the network cut off by a low deck) |
| Sim step, mean | 1.03, 1.27, 0.94 ms | 1.08, 1.19, 0.94 ms |

## Physics and ragdolls (2026-10-15)

The GTA IV physics pass (docs/physics.md). Cars cost what they did (four rays and a few impulses each). The new cost is the ragdolls: up to 6 at once with 11 bodies and 10 joints each. A frozen ragdoll has no bodies.

- **Sim step** (baked tile, traffic 0.75, 40 pedestrians, Node, 20 s each): 1.14 ms mean (1.50 p95) without ragdolls, and 1.42 ms (1.84 p95) with 6 kept active. That is about 0.05 ms per active ragdoll.
- **Snapshot.** Ragdoll records follow the entity records: 26 words each, at most 16, and only the ones in use are sent. `SNAPSHOT_BYTES` grew by 1.6 KB.
- **Client.** One instanced mesh per body part kind (12 in all), made at boot. Their count is 0 and they are hidden while nobody is down.
- **`npm run leaks`.** A new `ragdoll` phase (`--phases ragdoll --query transport=loopback`, 20 cycles) throws eight people round the player and removes them. Geometries went 235 -> 236 (unused 0), objects 925 -> 925, heap 84.6 -> 84.8 MB, and physics joints 0 -> 0: flat.
- **Default phases.** All flat, including `drive` with the new car.
- **`npm run perf-budget`.** desktop-high and desktop-medium passed. On desktop-low, the `drive.cpuP95` and `walk.cpuP95` tripwires (2.2 and 2.3 ms) were over by 0.1 to 0.3 ms in the first run on a loaded machine, then passed on a repeat (2.0 and 2.2 ms).

## Road markings: first-visit uploads (2026-10-14)

The re-baked tile has one road-markings mesh per 256 m chunk (62 of them), drawn only within 320 m x lodScale and hidden beyond. The soak's raw `geometries` count then rose by about 22 in the window it judges, and the soak failed against its limit of 8. The cause is not a leak: three.js uploads a geometry the first time it draws one of its objects, and frees it only on `dispose()`. Hiding a chunk does not free it, and does not need to. So the raw count rises once for every chunk the camera first sees, whatever its type (markings, ground levels, roads, buildings) and whatever the route, and never falls.

An 8-minute probe of the soak loop (desktop-medium, sampled every 15 s, each geometry tagged on its first draw) showed it: the raw count went 395 -> 535. Of that, 28 of the 62 markings meshes were drawn for the first time; the rest was ground levels and roads newly in view. It stood still at 523 from 3.75 to 4.75 min and at 535 from 6.5 to 8 min, while the bot drove over ground it had already covered. Markings were only part of the 22.

**The check now measures what can actually leak.** `scripts/lib/page.mjs` wraps `renderer.renderBufferDirect` (every draw, shadow passes included) and records which geometries have been drawn. `unusedGeometries` = the geometries the renderer holds minus the drawn ones still in the scene. A geometry that is uploaded and then removed from the scene without `dispose()` raises it; a first view does not, because the chunk is still in the scene. Checked with two temporary meshes: drawn and removed with `dispose()` five times gives +0; drawn and removed without it five times gives +5. The soak's limit (8) now applies to that number. The raw count is printed in every window and in the verdict, not judged.

A warm-up was the other option, and it does not fit: the bot's route is seeded but runs in real time, and a warm-up that covers every chunk in the tile would take far longer than the soak. The perf-budget geometry count is a budget, not a leak check: it is the count after one scripted route, re-baselined like the others (see below).

**Triangles.** The tile is denser: the budget for desktop-low `walk.triangles` was 150k and one run here measured 123k (the 157k report did not reproduce on this box; routes differ between runs). The new budget comes from the worst of two runs x1.3, so it covers route variation.

## The harnesses

All live in `scripts/`; each starts its own Vite server and Chromium unless you pass `--url <base>` (an already-running server) or `--dist` (a preview of `dist/`, after `npm run build`). They need the baked tile (`cd tools/pipeline && npm run bake`). Shared code: `scripts/lib/harness.mjs` (servers, profiles, boot) and `scripts/lib/page.mjs` (what runs in the page).

**The bot.** `scripts/lib/page.mjs` installs `window.__h.bot`, a scripted player that plays through the real input path (analog move, the E key) and follows the real street centrelines from `roads.json`: it walks out and back, gets in at the spot where it got out (that spot always works for the sim's enter/carjack rules), drives a wandering route at up to 13 m/s, parks, gets out, turns the camera round. It keeps cars off streets steeper than 18% (the ground mesh drapes some streets over trenches, see "Known problems") and remembers where it got wedged. The route is fixed (seeded) but the sim runs in real time, so runs differ slightly.

**Profiles** (`--profile`): `desktop-high`, `desktop-medium`, `desktop-low` (1280x720), `phone-low` (iPhone 15 Pro: 393x659 at 3x, touch, Low tier, CPU slowed 4x through CDP `Emulation.setCPUThrottlingRate`; `--throttle n` changes the factor).

### `npm run perf-budget` (about 90 s per profile and run)

The npm scripts run each profile twice (`--repeat 2`): timings keep each one's best, and counts keep the worst. A single p95 spike (one GC or a background job) tripped the 2.2 to 2.3 ms desktop-low CPU tripwires in single runs, while the same tree measured 1.1 to 1.2 ms on reruns.

```
npm run perf-budget                                   # desktop-high, medium, low against scripts/perf-budget.json
npm run perf-budget:phone                             # phone-low
node scripts/perf-budget.mjs --profile desktop-high --repeat 2   # best of 2 timings (noisy machine)
node scripts/perf-budget.mjs --write-budget --profile desktop-high,desktop-medium,desktop-low,phone-low --repeat 2
```

Four phases (idle 4 s, walk out and back 60 m, drive 40 s, look round 6 s). Per phase: `frameP50/P95` (ms between animation frames, so 16.7 on a 60 Hz display; it catches dropped frames), `cpuMean/P95` (main-thread ms per frame, `game.cpuMs`), `gpuP50/P95` (timer queries around `renderer.render`; Chromium only), `draws` and `triangles` (maximum of any frame, all passes), `slowFrames` (over 33 ms). Per run: `bootMs`, `heapMB` (after a forced GC), `geometries`, `textures`. Exits 1 when a number is over its budget or the page logs an error. `--write-budget` writes new budgets from the **worst** of the `--repeat` runs (the gate takes the best timing of the runs, and the worst count): timings x2 with at least 1 ms slack, rounded up to 0.1 ms; draws, triangles and geometries x1.3; slow frames at least 6; heap x1.4 + 10 MB; boot time x2. Frame times are not headroom-scaled: they are display-bound (16.7 ms at 60 Hz), so their budget is a fixed 25 ms drop threshold (x2 would accept 30 fps). The worst run is the base because timing tails (p95) swing about 2x between runs on this box, and triangle and draw counts follow where the bot drives; a budget from the best run failed its own re-check. Use `--write-budget` only after a change meant to cost more or less, and say why. `--uncapped` lifts the display's frame limit, which on a headless GPU only lets the main thread run ahead, so frame times mean nothing then.

Budgets (`scripts/perf-budget.json`, written 2026-10-14 from two runs each on the box above, with the road-markings tile): the count budgets are the ones that matter. The worst phase of each profile, budget now (before the markings tile in brackets):

| Profile | Draws | Triangles | CPU mean ms | Heap MB |
|---|---|---|---|---|
| Profile | Draws | Triangles | CPU mean ms | Heap MB |
|---|---|---|---|---|
| desktop-high | 620 (640) | 300k (270k) | 2.1 (2.7) | 56 (52) |
| desktop-medium | 590 (630) | 260k (240k) | 3.0 (2.7) | 56 (52) |
| desktop-low | 430 (450) | 190k (170k) | 1.9 (2.3) | 56 (51) |
| phone-low (4x CPU) | 330 (340) | 140k (120k) | 2.3 (2.9) | 55 (51) |

Frame-time budgets stay at 25 ms (16.7 ms measured on every profile). Geometry budgets are now 660, 649, 631 and 548 (were 705, 700, 692 and 601): the raw count follows the route (see "Road markings" below).

`node scripts/cpu-profile.mjs` (see "Main-thread CPU, profiled and trimmed" below) says where a frame's main-thread time goes: per system, per three.js phase, per function, with `--query` to compare variants.

### `npm run soak` (5 minutes; `--minutes 30` for a long one)

The bot loops (in, drive 45 s, park, out, walk out and back, look round) while a sample is taken every 15 s after a forced GC. Fails on a crash, a page error, **frame cost drifting up** (the best window's main-thread cost per draw call in the last third of the run against the best window of the first third, after the warm-up: at most 1.3x plus 1.5 us; best windows, because other programs on the machine only ever add to a window), **heap growth** (the median heap of the last third against the first third: 30 MB, or 6 MB/min), **GPU objects growing** (more than 8: the geometries the renderer holds that the scene no longer draws, and textures; the raw geometry count is reported but not judged, see "Road markings" below), or a bot that barely moved (see below). Limits are in the `soak` section of `scripts/perf-budget.json`.

### `npm run leaks`

Phases of repeated cycles, each followed by a forced GC and a count of JS heap, renderer geometries, textures, programs, materials and scene objects, client entities, DOM nodes and listeners; a phase passes when the second half stops growing. `reload` (24 cycles) drops the drawn tile, disposing every geometry, material and texture, and builds it again from the `.glb` files; `vehicle` (30) gets in and out of the car; `tiers` (18) switches graphics tiers (shadow maps are made and dropped; dev server only); `drive` (6) drives and parks. `--phases reload --scale 0.4` for a quick run. Results: all four flat (heap 28.3 -> 28.7 MB over 24 reloads; geometries, textures, programs and objects exactly flat). To check it can fail, removing `o.geometry.dispose()` from `WorldView.dispose` makes `reload` report `geometries +1760`.

Outside `reload`, geometries are judged like the soak: the ones uploaded that nothing in the scene draws any more (`unusedGeometries`). The raw count also rises once for each chunk or car part first drawn as the camera moves, then holds (the `vehicle` phase steps 404 -> 443 once and stays, with 0 unused throughout). The live phases (`drive`, `crowd`) run with traffic, where a car swaps to a full model (55 scene objects, about 10 materials) while it is touched, smoking or has a door open, and back after. So their objects and materials step by whole cars, and they allow three at once (170 objects, 36 materials). `reload`, `vehicle` and `tiers` stay exact.

### `npm run check:controls` and `check:controls:webkit`

The existing controls check, with a Chromium (default) or Playwright WebKit (`--browser webkit`) engine. WebKit runs every check, including the carjack and handling suites, and passes them all, on a build of WebKit 27.2 with WebGL2. If Playwright wants a WebKit build you do not have and cannot download, point `WEBKIT_PATH` at another one (`WEBKIT_PATH=~/.cache/ms-playwright/webkit-2359/pw_run.sh npm run check:controls:webkit`). The same variable works for the perf harness: `node scripts/perf-budget.mjs --browser webkit --profile phone-low` runs the bot in WebKit with the iPhone 15 Pro emulation (no timer queries and no `performance.memory` there, so those columns are empty); it measured 3.1 ms of main-thread time per frame, 16.1 ms frames, 160 draws, 72k triangles.

## The graphics tiers (`src/client/graphics.ts`)

| | Pixel ratio cap | Shadow map | Far plane | Ground level 1 from | Multisampling |
|---|---|---|---|---|---|
| High | 2 | 2048, 80 m | 2600 m | 400 m | on (desktop) |
| Medium | 1.5 | 1024, 50 m | 1400 m | 300 m | on (desktop) |
| Low | 1 | none | 700 m | 220 m | off |

What the GTA IV look spends per tier (`Tier.fx`, see "The GTA IV look" below):

| | facade | surfaces | post | bloom | haze | lamps | trees |
|---|---|---|---|---|---|---|---|
| High | 2 full | 2 full | 2 grade + bloom | 2 levels (1/4, 1/16) | on | 2 (80 poles, 56 pools, 1000 glows) | 2 (20 near with alpha leaf cards, 80 mid, 1,500 impostors) |
| Medium | 2 full | 2 full | 2 grade + bloom | 2 levels | on | 2 | 2 (as High, ranges x 0.75) |
| Low | 1 (no stains, streaks, slab lines, blinds) | 1 (no patches, cracks, stains, finest octaves) | 1 (one grade pass, no bloom) | 0 | on | 1 (36 poles, 28 pools, 500 glows) | 1 (no leaf cards: 36 mid, 600 impostors, no shadows) |

Touch devices start on Medium and the governor steps down after 3 s above 24 ms; `?graphics=low` forces Low (the phone profile does). Multisampling is off on touch devices and whenever `?graphics=low`. The coarse ground distance is `400 m x lodScale` (1, 0.75, 0.55), so new level-of-detail code should divide the distance it measures by `lodScale` as the header of `graphics.ts` says. On the phone profile Low draws 160 to 170 calls and 72k to 82k triangles; High draws up to 484 and 200k.

## Known problems the harnesses surfaced

- **Streets draped into trenches (fixed in the pipeline, 2026-10-14).** The bot's wedges had two causes. Some at-grade streets followed the 3DEP ground into freeway cuts (Auburn Avenue NE dropped 2.7 m and climbed again within 10 m, about 30%): the pipeline now designs smooth road profiles, bridges the dips and cuts and fills the heightmap to them (see "Road profiles" in the tile contract; 8,855 m of drivable road steeper than 12% became 348 m). The wedges near (107, -600) and (206, -680) were **buildings across the street**: an Overture footprint drawn over Andrew Young Intl Boulevard and another over Peachtree Street NE, so the collision mesh had an 80 m wall across the road. Footprints are now cut by the streets they stand on. The bot may drop its 18% rule and the soak its 60 m/min floor can be raised after a fresh measurement.
- Draw calls doubled with chunking (see above).

## Only on the real devices

- **GPU time.** The Radeon here takes under 0.5 ms a frame. An iPhone's GPU (tile-based, with a lot less fill rate) and the Apple Silicon Mac's will differ. Measure with Safari's Web Inspector (Timelines, Graphics) or Xcode's Metal System Trace on the device; Safari has no `EXT_disjoint_timer_query`, so the harness's `gpu` columns stay empty there.
- **iPhone memory.** Safari's limit is the real ceiling (a tab is killed well before the device's RAM runs out). Our JS heap is 30 MB and the tile's GPU buffers a few tens of MB; check total footprint with Instruments (Allocations, VM Tracker) after 10 minutes of driving. `measureUserAgentSpecificMemory` is Chromium only, so `leaks` reports no total there.
- **Thermal throttling and battery.** Only a long session on the phone shows it (the soak script does not).
- **Safari behaviour that WebKit-on-Linux does not copy:** the iOS address bar and safe areas, orientation changes, the touch controls' feel (the emulation sends touch events but is not a finger), audio unlock, real ProMotion 120 Hz timing, and Rapier's WASM compile time on A-series chips.
- **CPU throttling is a proxy.** 4x CDP throttling slows JavaScript on a desktop core; a phone's mix of JS, WASM and memory speeds differs. Treat the phone profile as a regression tripwire, and re-baseline it from numbers taken on a real phone with Safari's Web Inspector.

## Results (2026-10-14, this box)

- `npm run perf-budget`: PASS on desktop-high, medium, low (budgets re-baselined: the markings tile, two runs each).
- `npm run perf-budget:phone`: PASS (re-baselined, two runs).
- `npm run soak` (5 min, desktop-medium): PASS. Heap 32.3 -> 32.3 MB (0.0 MB/min), raw geometries +25 (first views, judged: unused +0), textures +0, CPU per draw call 2.8 -> 2.5 us (limit 5.2), 0 slow frames, 449 m/min driven.
- `npm run leaks`: PASS, all four phases flat (heap 31.5 -> 32.4 MB over reload, 24 cycles; geometries flat in reload at 196).
- `npm run check:controls`: all pass in Chromium (worker, shared0 and loopback transports) and in WebKit (worker transport).

## Next

- A cheaper crowd for Low: far people could drop their limbs (one instance each) and skip the pose solver.
- Merge materials to cut draws: walls and roofs differ only by roughness (0.9, 0.95); the road materials differ by colour and roughness and could carry the colour in the vertex colours. That removes about a quarter of the draws.
- Bigger chunks (512 m) for roads and buildings if draws bite.
- Far building and road impostors (README: "impostors for far buildings"): they are the next triangle cost once towers get detail.
- Real-device numbers, then re-baseline `phone-low`.

## The GTA IV look (2026-10-15)

The default look is now GTA IV's (`src/client/render/look/`, [docs/graphics-plan.md](graphics-plan.md) section 9). `?gfx=classic` is the old renderer, `&gfxoff=post,facade,surface,haze,lamps,bloom` switches parts off. It adds no geometry beyond the lamp poles (at most 80 instanced), no textures (everything is ALU in the material shaders), 3 to 4 instanced lamp draws at night (the poles by day), and a post chain: the scene into a half-float target, then (High and Medium) 6 small bloom passes and one composite, or (Low) the composite alone.

**Before and after, same tile, same session, same box** (`npm run perf-budget` and `perf-budget:phone`, best of 2, `--query gfx=classic` against the default; worst phase of each profile; the tile is mesh format 2 for both, so the triangle counts are the new tile's):

| Profile | Draws | Triangles | GPU p50 / p95 (timer queries) | Textures | Heap |
|---|---|---|---|---|---|
| desktop-high | 470 -> 455 | 401k -> 406k | 0.3 / 0.7 -> 0.6 / 1.3 ms | 6 -> 11 | 51.0 -> 51.3 MB |
| desktop-medium | 425 -> 428 | 329k -> 336k | 0.4 / 0.6 -> 0.7 / 1.3 ms | 6 -> 11 | 51.1 -> 50.9 MB |
| desktop-low | 289 -> 291 | 207k -> 207k | 0.2 / 0.5 -> 0.5 / 0.7 ms | 4 -> 5 | 50.0 -> 49.8 MB |
| phone-low (4x CPU) | 210 -> 206 | 167k -> 157k | 0.2 / 0.2 -> 0.3 / 0.4 ms | 4 -> 5 | 49.8 -> 50.1 MB |

Draws and triangles differ by route (the bot drives a different way each run), not by the look: the look draws the scene once, plus 7 post draws and 3 to 4 lamp draws at night, and the poles are about 1.5k triangles. **The CPU timings of those runs are not usable:** other jobs shared the machine (the phone profile's classic baseline read 9.8 ms of main-thread time a frame against 4.3 ms on a quiet box, and the default read 10.0), so the cpuMean and cpuP95 budgets, which were already being exceeded by the classic path in the same run, say nothing about the look. By construction the look's own main-thread work is small: the patch scan twice a second (a traverse of about 400 meshes), the post passes' submit (7 draws), and at night a lamp list rebuild when the camera has moved 15 m (up to about 2,000 lamps to sort, at most every 0.4 s). It was not timed on its own; re-measure the phone profile on a quiet machine.

**What the parts cost the GPU** (`node scripts/gfx-cost.mjs`: 150 frames on a fixed camera, frame limit off, `renderer.render` plus `gl.finish()`, traffic and people off, mean of the middle 80% in ms; "no X" is the default with one part switched off with `gfxoff`). The box's GPU is far faster than a phone's, so these say how the parts compare, not what a phone will do (the phone's A17 Pro is roughly a seventh of this GPU in compute; the phone viewport is 0.26 MP at Low and 0.58 MP at Medium against 0.92 MP here):

| Tier, view | classic | default | no post | no facade | no surface | no lamps |
|---|---|---|---|---|---|---|
| High, street by day | 0.44 | 0.51 | 0.47 | 0.49 | 0.49 | 0.50 |
| High, aerial by day | 0.68 | 0.81 | 0.73 | 0.77 | 0.78 | 0.76 |
| High, street at night | 0.46 | 0.51 | 0.50 | 0.50 | 0.50 | 0.52 |
| Medium, street by day | 0.41 | 0.48 | 0.44 | 0.47 | 0.48 | 0.45 |
| Medium, aerial by day | 0.67 | 0.75 | 0.72 | 0.76 | 0.78 | 0.75 |
| Low, street by day | 0.28 | 0.38 | 0.32 | 0.32 | 0.32 | 0.32 |
| Low, aerial by day | 0.45 | 0.51 | 0.49 | 0.50 | 0.48 | 0.49 |
| Phone Medium (393x659), street / aerial | 0.35 / 0.55 | 0.39 / 0.62 | 0.37 / 0.60 | 0.39 / 0.61 | 0.39 / 0.62 | 0.37 / 0.62 |
| Phone Low, street / aerial | 0.22 / 0.39 | 0.27 / 0.41 | 0.24 / 0.41 | 0.24 / 0.43 | 0.26 / 0.41 | 0.25 / 0.41 |

The whole look costs 0.05 to 0.13 ms on this GPU, the post chain about 0.03 to 0.06 of it, and no single part more than 0.04. Differences of 0.02 ms are noise. **The Low decision:** Low keeps a single grade pass (`post: 1`) rather than none. The grade is most of what makes the picture GTA IV (the desaturation, the cast and the lifted blacks: without it Low would look like a different game from Medium), it costs 0.05 ms here at 0.26 MP (a 2 MB half-float target and one full-screen pass), the phone-low profile with post off measured a GPU p50 of 0.2 ms against 0.3, and it has nothing that grows with the scene. The fallback if a real iPhone says otherwise is one line: `post: 0` on Low (the look then keeps its materials, haze, sky and lamps, and loses the grade and the vignette). Bloom is the part to cut first on a slow phone (`bloom: 0` on Medium).

**Budgets.** Raised: `textures` for desktop-high and desktop-medium from 8 to 14 (the post chain's render targets: the scene target and the four bloom targets, 6 -> 11 measured, x1.3); phone-low and desktop-low stay at 8 (5 measured). Nothing else was raised for the look: the count and GPU budgets hold. Still over, and not because of the look: the CPU means and p95s (a busy machine, see above) and the triangle budgets of desktop-high and desktop-medium, which the classic path exceeds in the same runs (401k against 370k, 329k against 330k) because the tile is now meshFormat 2 (pitched roofs, building parts, rooftop equipment); the phone-low triangle budget (160k) sits at the new tile's 157k to 167k. Those want re-baselining when the pipeline lane's tile settles.

**Memory.** The post chain is one RGBA16F target (8 bytes a pixel: about 7 MB at 1280x720, about 2 MB at 393x659, plus a 4x multisampled copy of about 30 MB where the canvas has MSAA) and four small bloom targets (none on Low: they are 2 x 2). No textures are added; the JS heap grows by about 0.3 MB. Programs: the look adds about 14 (the facade, 6 surface kinds, the sky, 4 post passes, the lamp materials); the leak harness shows them stable across reloads and tier switches.

**Gates.** `npm run leaks` passes (reload 453 -> 453 geometries, 9 -> 9 textures, programs 43 -> 43; tiers, drive, crowd and gunfire flat), `npm run check:controls` passes, `npm test` (674 tests, with new ones for the palettes, the grade, the tier fx, the lamp placement and the facade attributes) and `npm run build` pass. One full leaks run failed once with `reload` +5 geometries and `tiers` +24 unused, while the pipeline lane was baking a new tile; two reruns on a still tile pass, as does `--query gfx=classic`.

### Round 6 timing tripwires (2026-10-15)

The GTA IV physics, the ragdolls, solid props, the police pacing HUD and the street-name label together put desktop-low and phone-low over their p95 tripwires. Measured the same day on the same machine:

| | db7cc1a (before) | round 6 |
|---|---|---|
| phone-low cpuMean, by phase | 2.2 to 2.4 ms | 2.4 to 2.6 ms |
| phone-low cpuP95, worst phase | 5.4 ms (already over its 4.9 drive budget that day) | 6.0 to 7.3 ms |
| desktop-low drive.cpuP95 | | 2.3 to 2.5 ms (budget 2.2) |

So the round costs about 0.2 ms of main-thread time on average on the throttled phone, plus spikier p95 tails. Only the failing `cpuP95` lines were raised, to the worst seen that day x1.25 (desktop-low idle, walk, drive; phone-low every phase). Means, draws, triangles and heap are unchanged. `--write-budget` was not used: it doubles a noisy p95 (phone-low look would have gone 5.4 -> 14.2), which would make the tripwire useless.

`LawHud` and `GunHud` now read the viewport size from `game.viewW` / `game.viewH` (set on resize), not `canvas.clientWidth` in a frame: a layout read after the HUD's writes forces a synchronous reflow. The dialling markers do nothing in a frame with nobody dialling.

## People (2026-10-16)

Every pedestrian is now a skinned Blender body (`tools/blender/characters`, see its README): sixteen bodies, three levels of detail each (3,600 to 4,900, 1,000 to 1,450 and 360 to 500 triangles), one 22-bone skeleton that matches the sim's ragdoll, 31 clips, one 1.75 MB .glb (1.18 MB gzipped) loaded at boot beside the cars. `?peds=box` (or a failed load) keeps the old block figures; the numbers below compare the two on the same tree.

- **Who is drawn how** (`src/client/render/chars/PedViews.ts`). The player, officers and every ragdoll are `PedActor`s: a SkinnedMesh on its own skeleton, an AnimationMixer, the level of detail picked by distance (12 and 36 m at lodScale 1). The nearest few ordinary people are actors too (14 on High, 9 on Medium, 5 on Low, within 17 m x lodScale, those already near counting as 25% closer); a camera moving faster than 9 m/s (driving) promotes nobody new. Everyone else is the `SkinnedCrowd`: one InstancedMesh per body and level (LOD1 to 30 m, LOD2 beyond), a person written into one of them each frame, so a person changing level or body needs no bookkeeping.
- **Why the crowd is cheap.** Its animation is baked: every clip it plays (`CROWD_CLIPS`, 19 of them) is sampled at 20 fps through a real skeleton at load into one half-float texture of bone matrices (66 x 970 texels, 0.5 MB, a few ms to bake). The vertex shader reads two frames of up to two clips and blends them (so a crossfade from a walk to a stand is a number, not a mixer), and the palette (15 regions) is a texture row a person. There is no mixer, no bone, no skeleton for 150 people: the CPU writes 16 floats of matrix and 8 of animation a person per frame, one `planInto` into a reused buffer (no allocation). Shadows use a depth material with the same skinning. Actors are reused (a pool of ten, parked out of the scene with their bone texture given back), at most two are made a frame, and every mesh is drawn once off screen in the first three frames, with one actor, so no program is compiled and no geometry first uploaded when the first person walks up (that was a 100 ms stall at the phone's 4x throttle, and a "geometry grew" in the leak harness).
- **Animation level of detail.** Actors past 12 m are posed every second frame, past 36 m every fourth (a figure aiming, or in a one-shot, always). The clips themselves share one locomotion phase advanced at speed over the stride of the clips in play, so the feet keep to the ground and a blend of walk into jog does not make them fight.

Measured with `npm run perf-budget` on a quiet machine (load under 3), 60 people (High), 24 (Low), best of 2 (desktop) and 3 (phone), `?peds=box` then the default, same tree:

| Profile, phase | CPU mean ms, box -> skinned | Draws | Triangles (every pass) |
|---|---|---|---|
| desktop-high, idle | 1.83 -> 2.43 | 214 -> 228 | 352k -> 413k |
| desktop-high, walk | 1.87 -> 2.29 | 248 -> 246 | 409k -> 516k |
| desktop-high, drive | 1.91 -> 2.08 | 263 -> 259 | 425k -> 528k |
| desktop-high, look | 1.77 -> 2.08 | 249 -> 244 | 385k -> 441k |
| desktop-high, gunfire | 1.68 -> 2.01 | 170 -> 183 | 251k -> 328k |
| phone-low (4x CPU), idle | 4.59 -> 3.96 | 113 -> 111 | 178k -> 191k |
| phone-low, walk | 4.51 -> 4.39 | 121 -> 122 | 193k -> 207k |
| phone-low, drive | 5.01 -> 4.94 | 131 -> 132 | 212k -> 230k |
| phone-low, look | 4.29 -> 4.53 | 138 -> 123 | 192k -> 202k |
| phone-low, gunfire | 5.09 -> 5.47 | 103 -> 99 | 117k -> 131k |

(Taken just before the actor and crowd ranges were trimmed from 14 / 42 / 38 m to 12 / 36 / 30 m, which lowers the triangle rows a little.) GPU p50 is unchanged on both (0.4 to 0.5 ms desktop, 0.1 to 0.3 phone). Per run: boot +60 ms (desktop) and +170 ms (phone proxy), JS heap +8.7 MB (54 -> 63) and +7.6 MB, renderer geometries +57 (the crowd's per-body copies and the warmed assets) and +70, textures +11 and +3. The triangle increase is the cost of real bodies (a person is 4.5k near, 1.2k mid, 0.4k far where the box figure was about 200), and shadows draw them twice; the 3M budget is not near. The phone's GPU was not measured (the proxy is the CPU slowed 4x on a desktop GPU), and Safari was not tried: skinning is vertex-texture fetches (WebGL2 core), but a real iPhone 15 Pro run is the first thing to do.

`npm run leaks` passes with the ragdoll, crowd, vehicle, reload, tiers, drive, gunfire and wrecks phases flat. A frozen street (the harness's `pedBudget: 0` phases) now also pins who is an actor (`PedViews.pinned`, set by `scripts/leaks.mjs`), so a person walking across the near range is not counted as growth. Mixers and skinned meshes are disposed with their actor; pooled actors are out of the scene.

**Rough** (what to look at next): faces are stylised (the mesh has a brow, nose, cheekbones, jaw, chin and ears; eyes, brows, lips and the hairline are drawn by the shader, so there is no blink or talk); hands are mittens with a thumb; hair is a skull-hugging cap plus a flat sheet or a ponytail (no strands); shoes are simple; a skirt or a dress clips in the sit and cower poses (skin weights, no cloth); LOD2 is 360 to 500 triangles, not 300; aim pitch is a torso tilt, not a hand IK to the sight line; `enter_car` and `exit_car` are 0.7 s blends at the seat, not door-aware; the get-up clips (`getup_back`, `getup_front`) exist but the game uses the sim's own ragdoll-to-standing blend through the bones; the lamp pools of the look brighten legs at night.

## Blender cars (2026-10-15)

The box stand-ins are replaced by the scripted Blender cars of `tools/blender/` (sedan, coupe, pickup, and police cruisers on the sedan and coupe), loaded from `public/assets/vehicles/*.glb` (five files, 176 to 209 KB each, 0.95 MB in all, meshopt-compressed). Triangles per car at LOD0 / LOD1 / LOD2 (the wheel counted four times): sedan 8274 / 1908 / 460, coupe 8094 / 1832 / 472, pickup 8212 / 2198 / 526, sedan-police 8668 / 2044 / 508, coupe-police 8494 / 1968 / 520.

**Levels of detail** (`src/client/render/carLod.ts`, distances divided by the tier's `lodScale`): a full model (the player's car, police, a damaged or burning or opened traffic car within 45 m) draws LOD0 within 20 m, LOD1 to 55 m, LOD2 beyond, holding a level 2 m past its boundary. Instanced traffic draws LOD0 only within 9 m, LOD1 to 55 m, LOD2 beyond, as five instanced meshes per type and level in use (paint, detail, glass, lamps, wheels). Only the paint casts a shadow (and the wheels up close).

**Draws.** A full car is now about 17 draws at LOD0 (body by material, one lamp mesh for head, tail and reverse, the door, bonnet and bumpers, and all four wheels as one InstancedMesh per wheel material), 11 at LOD1 and 5 at LOD2, against 25 to 28 for the stand-in. That is where the police response got cheaper.

| 40 traffic cars and 4 police cruisers by the player, 1280x720 (90 frames, maximum) | Stand-in boxes (`?cars=box`) | Blender cars | Delta |
|---|---|---|---|
| desktop-high: draws / triangles | 448 / 256k | 405 / 304k | -43 / +48k |
| desktop-low: draws / triangles | 256 / 159k | 252 / 182k | -4 / +23k |

`npm run perf-budget` against `?cars=box`, the same day and tree: desktop-high draws fell by 50 to 175 a phase (walk 571 -> 420, look 610 -> 434), triangles rose by up to 60k (walk 298k -> 357k, drive 305k -> 359k); phone-low draws fell slightly (look 350 -> 208), triangles rose by up to 29k (drive 128k -> 157k). All the draw and triangle budgets hold. Main-thread CPU is about +0.1 ms a frame on desktop and +0.5 ms on the phone profile (its 4x slowdown), mostly in three's draw submission for the new materials; the CPU tripwires on this shared box were over for both the stand-in and the new cars. The geometry budgets went up (708 -> 880 desktop-high, 592 -> 780 phone-low): every car asset's geometry is uploaded once at boot (`EntityViews.prewarm` draws each asset at each level into a 1-pixel target, so nothing uploads or compiles mid-game), about 1 MB of GPU buffers.

**Damage** (`carDamage.ts`, `carModel.ts`) costs nothing until a car is hit: the first dent clones that car's near geometry (about 0.3 MB) and moves the vertices in the dent's sphere on the CPU (a millisecond or so per hit); the copies are freed with the model. Fallen bumpers are a pool of at most 10 pieces. `npm run leaks` passes all phases, and a new `wrecks` phase (`--phases wrecks --query transport=loopback`, 20 cycles: three cars wrecked through the client's event path, one blown up, then removed) is flat: geometries 626 -> 626, objects 1314 -> 1314.

## Trees, street furniture and their colliders (2026-10-16)

`src/client/render/Trees.ts`, `Furniture.ts`, `look/sodium.ts`, the lamp models in `look/lamps.ts`, and the colliders in `sim/World.ts` (`addProps`). Numbers from the dev box (load average 6 to 25, so timings are noisy; counts are exact).

**Assets** (`npm run assets`, deterministic: run twice, byte-identical): `trees.glb` 196 KB (5 species, near 710 to 1,220 triangles, mid 350 to 480), `furniture.glb` 39 KB (6 models, 180 to 340 triangles each). The impostor atlas is baked at load: 1024 x 640 RGBA16F (about 5 MB of GPU memory with mips), 40 small renders, one time.

**Draws and triangles on the fixed cameras** (`node scripts/gfx-cost.mjs --views park-day,auburn-day,auburn-night --variants trees,default`: the variant `trees` is `?gfxoff=trees`, so the difference is the trees and the small furniture only; the lamp models are in both). Centennial Park is the densest 100 m of the tile, Auburn Avenue a typical tree-lined street. Triangles include the shadow pass. GPU is `renderer.render` plus `gl.finish()` on a Radeon 8060S, a floor for any phone.

| Tier | View | Draws | Triangles | GPU ms |
|---|---|---|---|---|
| High | park, day | 69 -> 88 (+19) | 74k -> 142k (+68k) | 0.29 -> 0.37 |
| High | Auburn, day / night | 72 -> 89 (+17) / 76 -> 93 (+17) | 105k -> 129k (+24k) / 107k -> 131k (+24k) | 0.27 -> 0.37 / 0.31 -> 0.42 |
| Medium | park, day | 69 -> 86 (+17) | 71k -> 102k (+31k) | 0.27 -> 0.37 |
| Medium | Auburn, day / night | 71 -> 88 (+17) / 73 -> 90 (+17) | 102k -> 122k (+20k) / 104k -> 123k (+19k) | 0.29 -> 0.37 / 0.28 -> 0.35 |
| Low | park, day | 47 -> 53 (+6) | 45k -> 52k (+7k) | 0.16 -> 0.19 |
| Low | Auburn, day / night | 49 -> 55 (+6) / 52 -> 58 (+6) | 69k -> 75k (+6k) / 70k -> 76k (+6k) | 0.28 (noise) -> 0.22 / 0.17 -> 0.20 |
| Low, phone viewport | park / Auburn, day | 37 -> 43 (+6) / 39 -> 45 (+6) | 33k -> 40k (+7k) / 55k -> 60k (+5k) | 0.15 -> 0.17 / 0.18 -> 0.20 |

**The Downtown route of `npm run perf-budget`** (walk, drive, look; best of 2 or 3, same code with and without `gfxoff=trees`): there are few trees along it, so the difference is inside the noise: desktop-high +1 to +26 draws and -3k to +39k triangles, desktop-medium -6 to +32 draws and -33k to +9k, desktop-low +1 to +4 draws and +1k to +6k, phone-low +3 to +4 draws and about +1k (the Low tier draws 36 mid trees at most and no cards). GPU p50 moved 0 to +0.15 ms on desktop-high and medium and not at all on Low; CPU mean did not move beyond the run-to-run noise (1.4 to 2.5 ms desktop, 5 to 6 ms phone-low at 4x). Heap +1.5 to +8 MB (the geometry clones, the instance buffers, the atlas bookkeeping), geometries +6 to +14, textures +1 (the atlas), programs +2, boot about +50 ms (the bake; the runs scatter from +30 to +400 ms on a busy box). Re-baseline the budget file after this lands: the High and Medium triangle ceilings and the geometry ceilings are the ones that move.

**CPU per frame:** `Trees.update` rebuilds the instance lists when the camera has moved 4 m (at most every 0.35 s): a 64 m cell lookup, a sort of the trees in range (a few hundred to about 1,500) and a matrix per near or mid tree; well under 0.2 ms when it runs, nothing in between. The sway is a vertex-shader sine.

**Colliders.** The 4,185 trunks, 2,087 lamp poles and 119 hydrants, bins and bollards are 6,391 boxes. As separate fixed colliders `world.step()` went from 0.22 ms to 0.66 ms in Node (+0.44 ms a step, the whole sim step 1.53 to 1.89 ms; with the broad phase working on 7,600 entries instead of 1,300). Merged into one compound collider per 40 m cell (about 150 of them, the same boxes), it is 0.335 ms (+0.11) and the whole sim step 1.54 ms, within noise of no props. So `PhysicsWorld.addProps` merges the anchors and leaves the 380 signal poles, benches and bus stops as they were. The `propCells` map for the wall-clearance query still lists every box, so people walk round them. Collision audit (`AUDIT_MINUTES=3`, seeds 7, 11 and 23): 0 ambient pedestrians stuck or inside a footprint, `stepMsMean` 1.2 to 1.3; the scripted player bot, which does not steer round furniture, was pinned against a lamp twice in seed 11 (and in none of the other runs; without the anchors no run pins it) and the sim's own no-progress snap freed it.

**Sodium on cars, people and trees:** a fragment loop over at most 8 lamps (4 on Low) behind a uniform branch (`uSodOn`, 0 by day), added to the car materials by one `addSodium(shader)` call; selecting the lamps is a pass over the 2,087 lamp heads every 0.1 s when the camera has moved 1 m, only at night.

## Main-thread CPU, profiled and trimmed (2026-10-16)

The GTA IV look and the Blender cars (01b42b1) put the phone profile over its CPU tripwires (cpuMean 3.7 to 4.2 ms against 3.3 to 3.6, p95 7.5 to 8.8 ms, desktop-high `walk.cpuP95` 3.7 against 3.5, desktop-medium `drive.cpuP95` 3.4 against 3.0). The suspects were the car materials and the look's per-frame work. **Measured, neither is the main cost.**

**How to look** (`node scripts/cpu-profile.mjs --profile phone-low --phases idle,walk,drive [--query "gfx=classic&cars=box"] [--incl 40] [--callers update] [--alloc]`): the perf harness's bot, with every system's `update` and `lateUpdate` and `renderer.render` wrapped in `performance.now()` (ms a frame by system), plus a V8 sampling profile (CDP `Profiler`) folded into three.js phases by function name (`projectObject` is the scene traversal, culling and list building; `renderObjects` the draws; `setProgram` the program and uniform setup; `getProgram` the program lookup), self time by source and the top functions; `--alloc` adds a sampled allocation profile. Spikes: it prints the systems in the frames at or over p95. Deterministic things worth counting beside time, because this box is shared and timings swing 2 to 3x: GL calls a frame (wrap `WebGL2RenderingContext.prototype`), draws, `getProgram` calls, matrices recomputed.

**What the profile said** (phone-low, 4x CPU, ms a frame, quiet box, the tree of 01b42b1; the profiler adds a little):

| | walk, before | walk, after | drive, before | drive, after |
|---|---|---|---|---|
| whole frame (`Game.tick`) | 3.95 | 3.07 | 5.44 | 3.04 |
| `renderer.render` | 3.07 | 2.11 | 3.94 | 1.94 |
| - `projectObject` (traverse, cull, list) | 0.75 | 0.62 | 0.94 | 0.54 |
| - `renderObjects` (the draws) | 1.75 | 1.22 | 2.22 | 1.17 |
| - of it `setProgram` (uniforms) | 1.06 | 0.60 | 1.28 | 0.63 |
| - of it `getProgram` (program lookups) | 0.31 | 0.00 | 0.36 | 0.00 |
| - `updateMatrixWorld` | 0.43 | 0.08 | 0.58 | 0.07 |
| `entityViews` | 0.22 | 0.25 | 0.29 | 0.23 |
| `minimap` | 0.17 | 0.19 | 0.53 | 0.36 |
| `net` | 0.12 | 0.18 | 0.18 | 0.15 |
| `signalHeads` | 0.07 | 0.01 | 0.10 | 0.01 |
| `hud`, `street-name`, `look`, `atmosphere`, `gunHud`, `world`, `cameraRig` together | 0.20 | 0.25 | 0.25 | 0.24 |
| GC | 0.02 | 0.02 | 0.02 | 0.02 |

(The "after" runs were on a busier box than the "before"; `entityViews`, `net` and the small systems did not change and moved +-0.05 with the load. The real, repeatable changes are the rendering rows and `signalHeads`. Steady state allocates under 1 KB a frame: GC is not the p95 problem.) At 1x (no throttle) the same idle frame is 1.0 ms, three quarters of it in `renderer.render`.

**The look and the cars, separated** (`?gfx=classic`, `?cars=box`, `ab` of 3 interleaved rounds, phone-low idle, 4x, min of 3, load high): default 3.8 ms, classic look 3.5, stand-in cars 3.3, both 3.1. So the look is about 0.3 ms and the cars about 0.5 ms of a 3.8 ms frame; **3.1 ms is the floor both share**: three.js's cost per draw (the world's, the street's and the cars') and per scene object. The cost was never one system. It was draws: a world draw is about 10 us at 4x, but a car draw is 25 to 28 us, because nearly every car draw changes material (a car has its own paint, lamp and, once a window breaks, glass) and the transparent windows were two passes with a program lookup each.

**What was trimmed, and what it saved** (idle at spawn, phone-low, 1x, interleaved rounds of 600 frames, min of the rounds: 1.54 -> 0.98 ms, so -36%, with every item below in; deterministic counts where timing cannot see one item alone):

| Trim | Where | Saving |
|---|---|---|
| **Car windows drawn once.** three.js draws a transparent double-sided material twice, flipping `side` and setting `needsUpdate` around each draw, so every window re-resolved its program (parameters, cache-key string) every frame and the two passes alternated programs. `forceSinglePass`. The same frames rendered both ways differ by 0 of 255 on every pixel (the dark tint is the same on both layers). | `carMaterials.newGlass` | 12 `getProgram` calls and 6 draws a frame, 40 GL calls (7%); `getProgram` 0.3 ms at 4x -> 0 |
| **The tile's chunks merged 2 x 2 at load** (roads and buildings per material; ground levels and markings stay as they are). The chunks are 256 m and a mesh costs the same to cull, sort and draw at 50 or 5,000 triangles; the GPU has 10x to spare. Positions are baked to float32 in the tile's frame, everything else is copied (the look's shaders see the same attributes). `?mergeblock=1` turns it off. Screenshots of 6 fixed views at High and Low, before and after: at most 0.07% of pixels differ, all sub-pixel edges. | `world/mergeChunks.ts`, `WorldView` | world draws 58 -> 35 at spawn; whole frame -15 to -20%; **triangles +40 to +55%** (the cost, see the budgets) |
| **The scene no longer recomputes every world matrix every frame.** `Scene.matrixAutoUpdate` was true, which marks its world matrix changed every frame, and three then recomputed all ~770 descendants; now the scene, the entity, tile, traffic and signal groups are `matrixAutoUpdate = false`, and the tile and the asset cache (`car-asset-cache`, 223 hidden nodes) are `freezeStatic` (their `updateMatrixWorld` is skipped). Every object's matrix checked against a from-scratch composition: 0 differ, idle, walking and driving. | `Game`, `freeze.ts`, `EntityViews`, `WorldView`, `carAssets` | matrices recomputed 766 -> 84 a frame, visits 770 -> 180; `updateMatrixWorld` 0.43 -> 0.08 ms at 4x |
| **Hidden car levels of detail are taken out of the scene graph**, not hidden: a car is ~50 nodes and two thirds were levels nobody sees, each recomputed every frame. | `carModel.setLod` | with the above |
| **Parked cars away from the camera are drawn as instances** (beyond 26 m, back to a full model within 20 m, both divided by the tier's lodScale; creating a model costs 0.1 ms, so the swap is free). The same asset at the same level; only the shading of the trim differs. 24 fixed-camera pairs at 10 to 45 m, both tiers: inside the noise of the sky's drift (0.0 to 0.7% of pixels). `?parkedinst=0` keeps full models. | `EntityViews` | -6 draws a frame walking, 551 -> 493 GL calls at spawn (-10%): the 6 parked cars are no longer 18 draws and 12 materials of their own |
| **Shadow pass: instanced casters get their own depth material.** three.js draws every caster with one shared `MeshDepthMaterial`; instanced or not, with an instance colour or not, is part of a program's key, so each switch between plain and instanced casters looked the program up again: 9 a frame in a street. | `depthMaterials.ts` (a scan twice a second also covers other systems' instanced casters) | 9 -> 0 lookups a frame on High and Medium (about 0.08 ms of 2) |
| **Traffic's body parts share one matrix buffer** (paint, detail, glass and lamps sit where the car sits): one `setMatrixAt` and one upload, not four. | `TrafficInstances` | 3 uploads and 3 writes a car-set a frame |
| **Signal heads look at a junction when its stage ends**, not at every head every tick (319 `legState` calls a tick, each allocating a phase table, 60 times a second); the heads' chunks are 800 m, not 400 (fewer draws). `phaseOf` no longer allocates. | `SignalHeads`, `shared/signals.ts` | 0.08-0.10 -> 0.01 ms at 4x, and the allocation |
| **Radar does not redraw while nothing moves** (standing still, no heat, camera still: a refresh four times a second); the prompt scan skips cars farther than 8 m (it allocated a vector for every car every frame). | `minimap`, `Hud` | 0.15 -> 0 ms at 4x standing; nothing visible changes |
| The post chain's quad and scene no longer compose a matrix in each of its (1 to 7) render calls. | `post.ts` | below the noise |

GL calls a frame at spawn on Low, 877 -> 493 (the 01b42b1 tree against the same tree with these trims); draws at idle on the phone profile 156 -> 111 on the whole tree of today, people and trees included.

**Tried and dropped:** sorting opaque draws by program (46 -> 43 `useProgram`: three's material-id order already groups them); `matrixWorldAutoUpdate = false` (r186 still walks the subtree: `freezeStatic` replaces `updateMatrixWorld` instead); sharing every full car's paint and lamp material (probe: -14% on a street with 7 full cars, a real saving, but it means instanced full models with per-instance dirt, lamp and window state in `carMaterials.ts`, which the sodium hook is touching: not done); the look's per-frame uniforms (a dozen number writes, 0.01 ms: the lamps' list rebuild by day, the facade and the fog did not show in any profile, and the look's `update` is 0.03 ms at 4x).

**The leak harness** now counts a car's detached levels of detail as part of the car (`userData.lodGroups`), so the scene-object count does not follow which level the player's car is at. `npm run leaks` passes; its `vehicle` phase still steps by one extra full-model car at a time that varies from run to run (an old behaviour, also with `?parkedinst=0`), and flags it only when the step lands in the second half: rerun if so.

**After, on the whole tree** (the people and the trees are in, `npm run perf-budget` best of 2, twice; load 1 to 5 at the start of the runs, 22 once): CPU mean desktop-high 1.6 ms (budget 2.6 to 3.0), desktop-medium 1.4 to 1.6, desktop-low 1.1 to 1.3, **phone-low 2.7 to 3.2 (was 4.0 to 5.5 with the same people: "People" above)**; p95 desktop-high 2.8 to 2.9 (3.5), desktop-medium 2.4 to 2.8 (3.0), phone-low 5.6 to 7.2 (6.4 to 8.2). GPU p50 0.3 (phone), 0.5 to 0.7 (high): unchanged by 40% more world triangles.

**The last gate runs, and why the phone's means are not green.** `npm run perf-budget` passed (desktop, third try; the first two had load 20 to 27 near their ends and read 3 to 6x). `npm run perf-budget:phone` read idle 3.5 (budget 3.7) and **walk 4.4 to 4.6, drive 5.1, look 4.5 to 5.9, gunfire 5.3 to 5.4 against 3.3 to 3.9** in three runs at load 2 to 4, after the hero landmarks and the far tile landed in the tree (+11 to +14 draws on the route: walk 122 -> 136, drive 131 -> 142); the same code, before them, read 2.7 to 3.2 in two best-of-2 runs. With and without `?landmarks=off`, at idle, 1x, interleaved: 0.89 against 0.85 ms, so the landmarks are not heavy by themselves; the phone's walking and driving phases (people near, 4x throttle) are what moved, on a box where other jobs were also using the GPU. I did not raise the CPU budgets: they should be re-run on a quiet machine, and `node scripts/cpu-profile.mjs --profile phone-low --phases walk` says where the time goes (it printed `renderer.render` 4.2 ms of 5.7, `projectObject` 1.45, `renderObjects` 2.4 at load 2.8: the draws, as before).

**Budgets** (`scripts/perf-budget.json`; edited by hand from the two runs above, not `--write-budget`, which would double the noisy p95s): the CPU timings are unchanged, they pass with room. Draws came down to the worst run x1.3 (desktop-high 740 -> 340 at most, phone-low 430 -> 180 at most: the old ceilings had stopped catching anything). **Raised, and why:** triangles (the 2 x 2 merge draws more triangles to draw fewer meshes, +40 to +55%, and the people and trees add their own: desktop-high 380k -> 700k worst phase, desktop-medium 330k -> 560k, desktop-low 220k -> 370k, phone-low 170k -> 300k; the trees' +68k at Centennial Park is inside it); textures (people's bone texture and palette rows, the trees' atlas, the post chain: desktop-high 14 -> 29, medium 14 -> 24, low 8 -> 16, phone 8 -> 13); JS heap (60 -> 75 to 76 MB: the people and trees); boot time (the people's bake and the trees' atlas). Geometries came down (880 -> 793 desktop-high, 780 -> 741 phone-low): fewer, bigger meshes.

**What is left, and what it would take:**
- Car draws are about half of what is drawn on a street (the player's car is 17 draws at LOD0, the instanced sets are five parts per type and level). An instanced full model (shared paint, lamp and glass with per-instance dirt, lamps and broken windows) is worth about 10% of the frame on a street with several full-model cars; merging the closed door, bonnet and bumpers into the body for the player's car would be 6 draws. Both change `carMaterials.ts` and `carModel.ts` structurally.
- Merging the traffic sets of the three car types (one geometry per level with a per-instance type) would bound traffic to 15 draws; it needs a matching depth material for the shadow pass.
- `net` (0.1 to 0.2 ms at 4x: snapshot decode, `blendEntity`, the command `postMessage` every 14 ms) and `entityViews` (the crowd and ped poses: the people's lane) are now the biggest systems.
- Blocks of 3 x 3 chunks would cut 10 more draws for another +50% triangles: wait for a real phone's GPU numbers.
- The numbers here are a throttled desktop; the phone profile is a tripwire, see "Only on the real devices".

## Streaming (2026-10-16)

A streamed city (docs/contracts/city-tiles.md; `?tiles=fixture:3` or `?tiles=tiles/atlanta/m2/`) loads and drops 1024 m tiles round
the player in the sim worker and round the camera on the client. Measured with `STREAM_COST=1 NODE_OPTIONS=--expose-gc npx vitest
run tests/stream/cost.test.ts` (the sim, in Node) and `node scripts/stream-perf.mjs` (the browser, desktop-high and phone-low).

**The sim's cost of a tile** (the first two baked M2 tiles, `-2_-2` and `-1_-2`, west of Midtown; the M1 tile as one 2 km tile for
scale; the job budget at its default of 1,500 units a tick, a unit being about a microsecond on this box):

| | 1 km M2 tile | M1 (2 km) as one tile |
|---|---|---|
| Integration in all | 36 ms, over 26 ticks | 139 ms, over 116 ticks |
| Worst tick (p95) | 5.2 ms (3.4) | 16.7 ms (5.6): the Connector's deck structure, one piece that cannot be cut without cutting its internal edges |
| Heap held (parsed files let go, as in the game) | 5.5 MB | 25 MB |
| Rapier WASM memory | 2.7 MB | 18 MB (the decks twice: plain, and fixed for the hulls) |
| Typed arrays | 1.5 MB | 6 MB |

What a tick spends: building slices (1,024 triangles with their footprints: about 4 ms each), deck structures (whole, two copies),
prop cells (24 a job), the lane graph (one job, about 2.5 us a lane), the walk network, the car-ground window (1024 m: 3 ms at 4 m,
about 10 ms at 2 m), the seams and the main component (resumable). The first version of the budget counted a unit as a third of what
it costs and let a tick run 20 to 66 ms; the slices and the costs were cut until no tick of a 1 km tile passes about 5 ms. Dropping a
tile is one job of about 1 ms (removing colliders is cheap). A sim step with the streamer idle costs nothing more (the ring check is
four times a second).

**At 3 x 3** (desktop High's near ring of 900 m at the middle of a tile) a real 1 km tile is about 10 MB in the sim, so 9 tiles are
about 90 MB in the worker; on the phone (600 m: 6 tiles at most) about 60 MB. With the heightmap at 2 m add 1.6 MB a tile (the contract,
section 4).

**The client, on real tiles** (`node scripts/stream-perf.mjs --profile phone-low,desktop-high --tiles tiles/atlanta/m2/,m1`: the six
baked downtown M2 tiles streamed, against the single M1 tile in the same run, the same spawn-and-drive route, 1280 x 720, load average
under 4; phone-low is the iPhone 15 Pro viewport at 4x CPU):

| Profile | City | Tiles drawn / far | City GPU buffers | Heap | Idle CPU mean (p95) | Drive CPU mean (p95) | Draws idle / drive | Sim step worst | Tile work, ms a frame (worst / mean) |
|---|---|---|---|---|---|---|---|---|---|
| desktop-high | M2 streamed | 4 / 2 | 27 MB | 67 MB | 1.84 (3.0) | 1.63 (2.7) | 273 / 237 | 5.3 ms | 2.5 / 0.7 |
| desktop-high | M1 single tile | 1 / 0 | 25 MB | 66 MB | 1.95 (2.5) | 2.31 (3.8) | 231 / 287 | 31 ms | - |
| phone-low | M2 streamed | 3 / 2 | 21 MB | 60 MB | 3.29 (7.7) | 3.39 (6.7) | 114 / 129 | 3.0 ms | 8.7 / 2.4 |
| phone-low | M1 single tile | 1 / 0 | 25 MB | 65 MB | 2.88 (4.4) | 4.92 (8.3) | 111 / 155 | 31 ms | - |

No slow frame in any phase. Streaming costs about what the single tile does: the near ring holds three or four 1 km tiles (3 to 4 km2
against the M1 tile's 4), so the scene is the same size; the work of bringing a tile in is at most 2.5 ms in a desktop frame (8.7 ms
at 4x CPU) and 0.7 ms on average while it happens. (The M1 drive's 31 ms sim step is the M1 tile's own, not streaming's.) A first run
during a load average of 15 to 21 (other agents' bakes) read 9 to 13 ms of CPU for the same frames: these numbers need a quiet box.

**The client, on the fixture** (`fixture:3`, 384 m tiles, so more and smaller tiles than M2):

| Profile | Tiles drawn / far | City GPU buffers | Heap | Idle CPU mean (p95) | Drive CPU mean (p95) | Draws, triangles | Sim step worst | Tile add, ms a frame (worst / mean) |
|---|---|---|---|---|---|---|---|---|
| desktop-high | 27 / 22 | 16.8 MB | 57 MB | 3.1 ms (4.1) | 2.0 ms (3.0) | 208, 516k | 7.1 ms | 3.5 / 0.3 |
| phone-low (4x CPU) | 14 / 35 | 10.9 MB | 50 MB | 2.8 ms (4.1) | 5.6 ms (8.3) | 104, 194k | 8.3 ms | 6.4 / 1.0 |

No slow frame (over 33 ms) in any phase. A tile's meshes are added one a frame, and the city-wide sets (trees, lamps and furniture
through the look, benches and stops, signal heads, the minimap's per-tile atlases at 0.5 px a metre, the street names) are rebuilt one
a frame after a change. The far ring is drawn merged, one mesh per 4 x 4 block of tiles.

**Leaks**: `npm run leaks` has a `stream` phase (the fixture city, the sim on the main thread, the player sent 1.6 km away and back
each cycle): heap 99.8 -> 100.6 MB over 6 cycles, geometries, textures, programs and scene objects exactly flat, and the sim's
colliders (1,570), live lanes (1,990) and walk seam links (152) the same after every cycle.

## Hero landmarks (2026-10-16)

Twenty-two hand-built models (`tools/blender/landmarks/`, contract: "Hero landmarks"), 21 of them in the Downtown tile (the Basilica's waits for the tile to the north). What they cost, from `npm run perf-budget --repeat 2` on this (shared, loaded) box, with `?landmarks=off` (the same tile: the generic buildings still gone, the hulls still solid, only the models not drawn) against the default:

| What | Number |
|---|---|
| Files | 22 .glb, 0.64 MB together (20 to 150 KB each, meshopt); fetched after the world is up, in parallel; the first frame never waits for them |
| Triangles | 0.2 to 6.3k at LOD0 (the stadium 5.8k, the Capitol 6.3k, the wheel 3.7k; 27k for all 21 if every one were near), 0.07 to 2.2k at LOD1 (14k all together) |
| Materials / draws | LOD0 5 to 10 meshes a hero, LOD1 3 to 5 (the far level merges metal, glass, dark and roof into the stone material); `castShadow` on all but the glowing parts, so only the heroes inside the shadow frustum are drawn twice |
| Draws on the routes | desktop-high idle +15, walk +50, look +15 (drive and gunfire read lower, with other changes in the tree: the routes differ run to run); phone-low idle +3, walk +22, drive +23, look +22, gunfire +6 |
| Triangles on the routes | inside the route noise (-90k to +11k): the models are 1 to 5% of a frame's triangles; the generic buildings they replace were never culled any better |
| Geometries / textures | +50 to +90 geometries, +1 to +2 textures (the shader programs of `lm_gold`, `lm_glass` and the like have none; the count is the post chain's after a program change) |
| Boot, heap | boot +0.07 to +0.13 s (the models load after it), JS heap +4 MB |
| CPU, GPU | desktop-high cpuMean 1.6 to 2.4 against 1.8 to 2.4 without (noise), phone-low cpuMean 4.1 to 5.5 against 3.6 to 4.6 at idle and walk; GPU p50 0.4 to 0.6 ms on desktop, 0.1 to 0.4 on the phone profile (the two runs of the same comparison, earlier, read it the other way round: the box was the variable) |

Each model's facade is the look's window shader on the same attributes as the baked walls, so it costs what a wall costs; the extra shaders (`lm_glow`, `lm_flood`, `lm_lit`, `lm_gold`, `lm_glass`) are a few lines of emissive each and `addSodium` on the stone, metal, gold and flood materials. A level is chosen once a frame by distance (a distance, a divide and a compare a hero, no allocation); nothing moves, so the group is `freezeStatic`. **Budgets were not changed.** If draws matter on the phone, the cheap lever is `Landmarks.select`: hide LOD1 beyond the tier's `far` and merge the facade and roof meshes of a hero.

