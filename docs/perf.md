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

## The harnesses

All live in `scripts/`; each starts its own Vite server and Chromium unless you pass `--url <base>` (an already-running server) or `--dist` (a preview of `dist/`, after `npm run build`). They need the baked tile (`cd tools/pipeline && npm run bake`). Shared code: `scripts/lib/harness.mjs` (servers, profiles, boot) and `scripts/lib/page.mjs` (what runs in the page).

**The bot.** `scripts/lib/page.mjs` installs `window.__h.bot`, a scripted player that plays through the real input path (analog move, the E key) and follows the real street centrelines from `roads.json`: it walks out and back, gets in at the spot where it got out (that spot always works for the sim's enter/carjack rules), drives a wandering route at up to 13 m/s, parks, gets out, turns the camera round. It keeps cars off streets steeper than 18% (the ground mesh drapes some streets over trenches, see "Known problems") and remembers where it got wedged. The route is fixed (seeded) but the sim runs in real time, so runs differ slightly.

**Profiles** (`--profile`): `desktop-high`, `desktop-medium`, `desktop-low` (1280x720), `phone-low` (iPhone 15 Pro: 393x659 at 3x, touch, Low tier, CPU slowed 4x through CDP `Emulation.setCPUThrottlingRate`; `--throttle n` changes the factor).

### `npm run perf-budget` (about 90 s per profile)

```
npm run perf-budget                                   # desktop-high, medium, low against scripts/perf-budget.json
npm run perf-budget:phone                             # phone-low
node scripts/perf-budget.mjs --profile desktop-high --repeat 2   # best of 2 timings (noisy machine)
node scripts/perf-budget.mjs --write-budget --profile desktop-high,desktop-medium,desktop-low,phone-low --repeat 2
```

Four phases (idle 4 s, walk out and back 60 m, drive 40 s, look round 6 s). Per phase: `frameP50/P95` (ms between animation frames, so 16.7 on a 60 Hz display; it catches dropped frames), `cpuMean/P95` (main-thread ms per frame, `game.cpuMs`), `gpuP50/P95` (timer queries around `renderer.render`; Chromium only), `draws` and `triangles` (maximum of any frame, all passes), `slowFrames` (over 33 ms). Per run: `bootMs`, `heapMB` (after a forced GC), `geometries`, `textures`. Exits 1 when a number is over its budget or the page logs an error. `--write-budget` writes new budgets (timings x2 with at least 1 ms slack, draws, triangles and geometries x1.3, slow frames at least 6, heap x1.4 + 10 MB): use it only after a change meant to cost more or less, and say why. `--uncapped` lifts the display's frame limit, which on a headless GPU only lets the main thread run ahead, so frame times mean nothing then.

Budgets (`scripts/perf-budget.json`, from two runs on the box above): the count budgets are the ones that matter. Measured, per profile, the worst phase:

| Profile | Draws | Triangles | CPU mean ms | Heap MB |
|---|---|---|---|---|
| desktop-high | 484 | 200k | 0.9 | 29.6 |
| desktop-medium | 402 | 163k | 0.9 | 29.5 |
| desktop-low | 339 | 126k | 0.6 | 29.0 |
| phone-low (4x CPU) | 167 | 82k | 1.0 | 29.0 |

### `npm run soak` (5 minutes; `--minutes 30` for a long one)

The bot loops (in, drive 45 s, park, out, walk out and back, look round) while a sample is taken every 15 s after a forced GC. Fails on a crash, a page error, **frame cost drifting up** (the best window's main-thread cost per draw call in the last third of the run against the best window of the first third, after the warm-up: at most 1.3x plus 1.5 us; best windows, because other programs on the machine only ever add to a window), **heap growth** (the median heap of the last third against the first third: 30 MB, or 6 MB/min), **geometries or textures growing** (more than 8), or a bot that barely moved (see below). Limits are in the `soak` section of `scripts/perf-budget.json`.

### `npm run leaks`

Phases of repeated cycles, each followed by a forced GC and a count of JS heap, renderer geometries, textures, programs, materials and scene objects, client entities, DOM nodes and listeners; a phase passes when the second half stops growing. `reload` (24 cycles) drops the drawn tile, disposing every geometry, material and texture, and builds it again from the `.glb` files; `vehicle` (30) gets in and out of the car; `tiers` (18) switches graphics tiers (shadow maps are made and dropped; dev server only); `drive` (6) drives and parks. `--phases reload --scale 0.4` for a quick run. Results: all four flat (heap 28.3 -> 28.7 MB over 24 reloads; geometries, textures, programs and objects exactly flat). To check it can fail, removing `o.geometry.dispose()` from `WorldView.dispose` makes `reload` report `geometries +1760`.

### `npm run check:controls` and `check:controls:webkit`

The existing controls check, with a Chromium (default) or Playwright WebKit (`--browser webkit`) engine. WebKit runs every check, including the carjack and handling suites, and passes them all, on a build of WebKit 27.2 with WebGL2. If Playwright wants a WebKit build you do not have and cannot download, point `WEBKIT_PATH` at another one (`WEBKIT_PATH=~/.cache/ms-playwright/webkit-2359/pw_run.sh npm run check:controls:webkit`). The same variable works for the perf harness: `node scripts/perf-budget.mjs --browser webkit --profile phone-low` runs the bot in WebKit with the iPhone 15 Pro emulation (no timer queries and no `performance.memory` there, so those columns are empty); it measured 3.1 ms of main-thread time per frame, 16.1 ms frames, 160 draws, 72k triangles.

## The graphics tiers (`src/client/graphics.ts`)

| | Pixel ratio cap | Shadow map | Far plane | Ground level 1 from | Multisampling |
|---|---|---|---|---|---|
| High | 2 | 2048, 80 m | 2600 m | 400 m | on (desktop) |
| Medium | 1.5 | 1024, 50 m | 1400 m | 300 m | on (desktop) |
| Low | 1 | none | 700 m | 220 m | off |

Touch devices start on Medium and the governor steps down after 3 s above 24 ms; `?graphics=low` forces Low (the phone profile does). Multisampling is off on touch devices and whenever `?graphics=low`. The coarse ground distance is `400 m x lodScale` (1, 0.75, 0.55), so new level-of-detail code should divide the distance it measures by `lodScale` as the header of `graphics.ts` says. On the phone profile Low draws 160 to 170 calls and 72k to 82k triangles; High draws up to 484 and 200k.

## Known problems the harnesses surfaced

- **Streets draped into trenches.** Some at-grade streets follow the 3DEP ground into freeway cuts: Auburn Avenue NE (`osm:way/1118731507`) drops from -10.8 to -13.5 m and back within about 10 m near x = 565, z = -139, a grade of about 30%. Cars stop there. The bot avoids streets over 18%; the pipeline should model those spans as bridges or flatten the road profile. The bot also gets wedged elsewhere (near (107, -600) and (206, -680), cause not looked into), so the soak's bot drives 190 m a minute on average although its first drive does 500 m in 40 s; the soak's limit for that is 60 m a minute.
- Draw calls doubled with chunking (see above).

## Only on the real devices

- **GPU time.** The Radeon here takes under 0.5 ms a frame. An iPhone's GPU (tile-based, with a lot less fill rate) and the Apple Silicon Mac's will differ. Measure with Safari's Web Inspector (Timelines, Graphics) or Xcode's Metal System Trace on the device; Safari has no `EXT_disjoint_timer_query`, so the harness's `gpu` columns stay empty there.
- **iPhone memory.** Safari's limit is the real ceiling (a tab is killed well before the device's RAM runs out). Our JS heap is 30 MB and the tile's GPU buffers a few tens of MB; check total footprint with Instruments (Allocations, VM Tracker) after 10 minutes of driving. `measureUserAgentSpecificMemory` is Chromium only, so `leaks` reports no total there.
- **Thermal throttling and battery.** Only a long session on the phone shows it (the soak script does not).
- **Safari behaviour that WebKit-on-Linux does not copy:** the iOS address bar and safe areas, orientation changes, the touch controls' feel (the emulation sends touch events but is not a finger), audio unlock, real ProMotion 120 Hz timing, and Rapier's WASM compile time on A-series chips.
- **CPU throttling is a proxy.** 4x CDP throttling slows JavaScript on a desktop core; a phone's mix of JS, WASM and memory speeds differs. Treat the phone profile as a regression tripwire, and re-baseline it from numbers taken on a real phone with Safari's Web Inspector.

## Results (2026-10-14, this box)

- `npm run perf-budget`: PASS on desktop-high, medium, low and phone-low (budgets written from them).
- `npm run soak` (5 min, desktop-medium): PASS. Heap 29.4 -> 29.6 MB (0.1 MB/min), geometries +6, textures +0, CPU per draw call 2.8 -> 3.5 us (limit 5.2), 0 slow frames in 20 windows, sim step at most 1.3 ms, 5 enter/exit cycles, 957 m driven, 228 m walked.
- `npm run leaks`: PASS, all four phases flat.
- `npm run check:controls`: all pass in Chromium (worker, shared0 and loopback transports) and in WebKit (worker transport).

## Next

- Merge materials to cut draws: walls and roofs differ only by roughness (0.9, 0.95); the road materials differ by colour and roughness and could carry the colour in the vertex colours. That removes about a quarter of the draws.
- Bigger chunks (512 m) for roads and buildings if draws bite.
- Far building and road impostors (README: "impostors for far buildings"): they are the next triangle cost once towers get detail.
- Real-device numbers, then re-baseline `phone-low`.
