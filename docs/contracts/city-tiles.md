# City tiles: the multi-tile format and how it streams

M1 is one baked 2 x 2 km tile ([m1-tile-format.md](m1-tile-format.md)). M2 is a city of many tiles that the sim and the client
load and drop around the player. This file is the contract between the pipeline (`tools/pipeline/`), the sim worker
(`src/sim/stream/`) and the client (`src/world/stream/`). Change it before changing the code.

**Every tile is still an M1 tile.** A city adds an index over them, puts them all in one frame, and says how their edges meet.
Everything in [m1-tile-format.md](m1-tile-format.md) holds for each tile, with the changes listed here. A city of one tile (the
served `m1-five-points`) needs none of this and works as before.

## 1. The city index (`index.json`)

```jsonc
{
  "format": "hood-city", "version": 1,
  "id": "atlanta/m2",                         // city id / grid id
  "city": "atlanta",                          // the city pack (data/cities/<city>/): law, population, zones
  "projection": "+proj=tmerc +lat_0=33.85 +lon_0=-84.3 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
  "origin": { "lat": 33.7543, "lon": -84.3898, "E": -8319.964, "N": -10611.308 },   // the city frame: x = E - E0, z = -(N - N0)
  "baseElevation": 318.59,                    // y = elevation - baseElevation, for every tile
  "tileSize": 1024,                           // m; tile (i, j) covers x in [i*S, (i+1)*S], z in [j*S, (j+1)*S]
  "heightmapCellSize": 4,
  "tiles": [ {
    "id": "0_-3",                             // "<i>_<j>", the grid cell
    "i": 0, "j": -3,
    "bounds": { "minX": 0, "minZ": -3072, "maxX": 1024, "maxZ": -2048 },
    "path": "tiles/0_-3/",                    // relative to index.json; holds an M1 tile.json and its files
    "version": "5f2a9c1e",                    // content hash of the tile's files (cache busting; R2 keys)
    "bytes": 3145728,                          // all files of the tile
    "far": "tiles/0_-3/far.bin",             // optional: the skyline level of detail (section 8)
    "region": "midtown",                      // the city.json region that asked for it
    "counts": { "lanes": 1900, "walkNodes": 3600, "walkEdges": 3900, "props": 1700, "collisionTris": 16000 },
    "neighbours": { "n": "0_-4", "e": "1_-3", "s": "0_-2", "w": "-1_-3" }   // null where the grid has no tile
  } ],
  "spawn": { "tile": "-1_-1", "player": { "x": 3.1, "y": -0.1, "z": 8.7 }, "vehicle": { "x": -2.6, "y": 0.3, "z": 13.8, "heading": -0.58 } },
  "attribution": ["© OpenStreetMap contributors", "Overture Maps Foundation", "USGS 3DEP"],
  "seams": { "matched": 1210, "unmatched": 31, "maxStep": 0.0 },   // what the bake's seam pass found (section 4)
  "built": "2026-10-16T20:00:00Z"
}
```

- The grid is **sparse**: only the cells a region of `city.json` asks for are listed. A missing neighbour is the edge of the
  world there: lanes turn round, walkers stop, the ground ends (the bounds system treats it like a tile edge in M1).
- `counts` are upper bounds the runtime sizes its pools from (it also copes without them).
- `tiles/<id>/tile.json` is an M1 manifest with these differences: `origin` and `baseElevation` are the city's (not the
  tile's own centre), `bounds` is the cell, and `id` is `<city id>/<tile id>` (`atlanta/m2/0_-3`). Its `heightmap.minX/minZ`,
  `chunks.minX/minZ`, spawns and every coordinate in every file are in the city frame.
- `index.json` for the browser fixture (`?tiles=fixture`) is made in memory by `src/shared/fixture.ts`; nothing is fetched.

### `city.json` (the pack) describes the grid to bake

```jsonc
"grids": [ {
  "id": "m2", "name": "M2: Intown and the river",
  "origin": { "lat": 33.7543, "lon": -84.3898 }, "baseElevation": 318.59,
  "tileSizeM": 1024, "heightmapCellSizeM": 4, "groundMeshStep": 1, "chunkSizeM": 256, "queryMarginM": 160,
  "out": "public/tiles/atlanta/m2",
  "regions": [ { "id": "downtown", "name": "Downtown and the Connector", "cells": [[-2, -2], [1, 1]] }, ... ]   // inclusive cell rects
} ]
```

The M1 `tiles` list stays as it is. `npm run bake:m2` (section 10) bakes a grid; `npm run bake` still bakes `m1-five-points`.

## 2. One frame for the whole city

- **One projection, one origin, one datum.** Every tile is in the city frame (the M1 projection and the M1 origin, Five Points,
  so a position in the M1 tile is the same position in M2) and every height is above the city's `baseElevation`. A tile is
  never moved or rebased at runtime: its numbers are used as they are.
- The pipeline may bake a tile in a frame of its own (centred on the cell, its own datum) and translate it: the projection is a
  transverse Mercator with a fixed central meridian, so a tile's local frame differs from the city frame by a translation only
  (`dx`, `dz` from the projected centres, `dy` from the two datums). Section 10 says how.
- Tile size: **1024 m** for M2 (256 heightmap cells, 4 chunks of 256 m, no short chunk). A 1 km tile is a quarter of the M1 tile's
  data (about 3 MB on disk, section 9), small enough that the ring the phone keeps is a few of them.

## 3. Ids across tiles

Ids inside a tile file are local: a lane edge index, a walk node index, a junction id `j12`. The runtime gives every tile a
**slot** and every element a global index: `slotBase + local`. Slots are reused first-fit when tiles drop, so the global ids of
the tiles that stay never change while they are loaded (a car on edge 9041 is on edge 9041 until it or its tile goes).
Junction ids, which the signals hash, become `<tile id>/<id>` in a multi-tile city (a single-tile city keeps `j12`, so its signal
timing does not change). OSM ids (`osm:way/123`) are already global and stay as they are: the same way cut by a seam has the same
`road` on both sides, which is what the stitching keys on.

## 4. Seams

A seam is the shared edge of two neighbouring cells: the line `x = i*S` (an east-west neighbour) or `z = j*S` (north-south).

### Heights and ground

- Each tile's heightmap covers its cell **with both edges**: `(S / cell + 1)` samples a side, so two neighbours both hold the
  samples on their seam. **They must be identical** (the bake's seam pass makes them so, below). The runtime checks one seam
  sample in 16 when it loads a neighbour and logs `seam: height mismatch <a>|<b> up to <m> m`; it does not repair the data.
- The ground meshes' border vertices stand on those samples, so neighbouring tiles' level 0 ground meets exactly; level 1 keeps its
  border on the terrain and its 3 m skirt, so a coarse tile beside a fine one shows no crack (the same rule as between chunks).
- Physics: each tile has its own heightfield. Two heightfields meet at a seam with no step, but a car's hull would feel the seam as
  an unfixed internal edge (the ghost contacts of `docs/ground-audit.md`). So **cars' hulls do not meet the tiles' heightfields**:
  they meet one **car-ground window**, a single heightfield with `FIX_INTERNAL_EDGES` of 1024 x 1024 m (at the tiles' cell size)
  cut from the loaded tiles around the player and rebuilt (one collider swap at a tick boundary) when the player is more than 192 m from its
  centre. Physics cars are always within about 110 m of the player (traffic demotes them beyond `demoteDist`), so every hull is on
  it. People, ragdolls, rays and the wheels meet the plain per-tile copies, as in M1. Where no tile is loaded the window is
  low (a hole), as is the world.

### Heightmap resolution (2 m, and road corridors)

**Decided (ground lane, round three, 2026-10-16): the heightmap stays at 4 m.** A 2 m bake of M1 was measured with the ground
audit and was worse, not better: 291 to 325 launches against 255 at 4 m (three variants of the corridor smoothing), more ghost
contacts on the finer facets, and the tile over its 15 MB budget (`height.bin` 1.0 to 4.0 MB, 15.1 MB in all); the sim's RSS rose
24 MB (the samples, 1 to 4 MB, in JS and in each of Rapier's two heightfield copies). The launches that are left come from deck seams, junction carving
and the cars' hull contacts, not from the cell size (see `docs/ground-audit.md`, round three). The format below stays as it is,
so a grid may still choose 2 m or the corridor layer later; nothing in the runtime assumes 4 m:

- **Per tile.** `tile.json.heightmap.cellSize` is already per tile; the runtime (sim, car-ground window, `heightAt`) reads it and
  assumes nothing about 4 m. A grid's tiles share **one** cell size (`index.json.heightmapCellSize`, `city.json`
  `heightmapCellSizeM`): a 1024 m tile is 513 x 513 samples at 2 m (257 at 4 m), both edges included, so neighbours share their
  seam row or column **at the fine resolution** and the bake's seam pass makes those samples identical (it is written for any cell
  size). Tiles of different cell sizes may only meet where the finer one's seam samples between the coarser one's are the linear
  interpolation of them along the edge (watertight); the runtime logs anything else as a seam mismatch.
- **A road-corridor layer** (the alternative): `tile.json.heightmapFine = { file: "height-fine.bin", cellSize: 1 | 2, block: 32,
  blocks: [[bx, bz], ...] }`, square blocks of `block` cells of the fine size, aligned to the coarse grid, only where roads are,
  each `(block + 1)^2` little-endian float32 samples in the order of `blocks`. A block's border samples equal the coarse surface
  there (watertight), and **no block may touch a seam** (the seam stays the coarse samples, so stitching is unchanged). Physics:
  Rapier's heightfield has no holes, so the coarse heightfield would stand above a corridor that is cut below it; the layer
  therefore needs the coarse samples inside a block's interior lowered to the block's lowest fine sample (the coarse vertices on
  block borders keep their values), with the block's own heightfield (fine, `FIX_INTERNAL_EDGES` for the hulls) on top. The
  runtime will add each block as one more job of the tile (not built yet: until a bake writes the layer, `heightmapFine` is absent
  and ignored).
- **Memory per resident tile, iPhone 15 Pro** (1024 m tile; section 8 has the totals):

  | | 4 m | 2 m |
  |---|---|---|
  | `height.bin` (JS, kept for `heightAt` and the window) | 0.26 MB | 1.05 MB |
  | Rapier heightfield (WASM heap) | 0.26 MB | 1.05 MB |
  | Car-ground window (one for the city, 1024 m) | 0.26 MB | 1.05 MB |
  | Ground mesh if drawn at the heightmap's resolution (level 0, GPU) | 131k triangles, about 3 MB | 524k triangles, about 12 MB |

  So 2 m physics costs about 1.6 MB more per tile (10 MB over the phone's six near tiles): fine. **Drawing** the ground at 2 m is
  not: the ground mesh should stay at 4 m (`groundMeshStep: 2` over a 2 m heightmap) except within the road corridors, or the
  roads' own ribbons carry the shape; the client does not care which, as long as the drawn ground is within a few centimetres of
  the physics under the roads (the ground audit's `visual-mismatch`).
- The car-ground window samples at the loaded tiles' cell size (257 x 257 at 4 m, about 3 ms; 513 x 513 at 2 m, about 13 ms), so
  it is built by a resumable job a few columns a tick, and swapped in when it is whole (the old one stays until then).

### Lanes, walk paths and roads cross a seam as ports

- The bake cuts every road, lane and walk path **exactly at the seam line** in both tiles (M1 already clips to the bounds). A seam
  is crossed only by plain lanes and walk edges: no junction polygon, connector, deck end or crossing may straddle it. (A junction
  within 20 m of a seam is the bake's problem: the seam pass reports it as unmatched, section 10.)
- A **seam port** is a lane end, a walk node or a road end that lies on the seam line (within 0.05 m). Its key is stable and the
  same from both sides:
  - lane: `L|<axis><line>|<road>|<dir>|<k>|<ordinal>`, e.g. `L|x1024|osm:way/123|1|0|0`: the seam (`x1024` is the line x = 1024,
    `z-2048` the line z = -2048), the `roads.json` id, the lane's direction and number, and an ordinal for a road that crosses the
    same seam line more than once (counted along the line). A lane that ends on the seam is an **out** port, one that starts on it
    an **in** port; an out port of one tile matches the in port of the other with the same key.
  - walk node: `W|<axis><line>|<along>` with `along` the position along the line in 0.5 m steps. A walk **dead end within 4 m** of
    a seam (not on it) is a port too, `W|<axis><line>|near|<along>`: the baked walk network is resampled and cut by footprints, so it
    seldom ends exactly on a tile's edge (the first two M2 tiles share one walk node on their seam; with the dead ends, six pairs).
  - road end (police road graph, minimap): `R|<axis><line>|<road>|<ordinal>`.
- `seams.json` in each tile lists its ports by side (optional; the runtime computes the same list with `seamPorts()` in
  `src/shared/seams.ts`, the function the pipeline calls to write it):
  ```jsonc
  { "version": 1, "tile": "0_-3",
    "sides": { "e": { "line": 1024, "axis": "x",
                      "lanes": [ { "key": "L|x1024|osm:way/123|1|0|0", "edge": 12, "end": "out", "p": [1024, 3.1, -2500.2] } ],
                      "walk":  [ { "key": "W|x1024|-2493.5", "node": 881, "p": [1024, 3.2, -2493.5] } ],
                      "roads": [ { "key": "R|x1024|osm:way/123|0", "road": 40, "end": 1 } ] }, "n": {...}, "s": {...}, "w": {...} } }
  ```
- **Stitching (runtime).** When both tiles of a seam are loaded, every out port is joined to the in port with its key, checked:
  within 0.75 m in plan and 0.25 m in height, and the two lanes' directions within 20 degrees. A joined lane's `next` becomes the
  other tile's lane (its own turnaround connector, which the bake adds where a two-way road leaves the tile, is taken out of `next`
  while the seam is joined, and put back when the neighbour drops). Walk ports are joined by a `link` edge, nearest pairs first: two
  on the seam within 0.75 m, or a near dead end within 6 m (and 0.6 m in height) of a port across. Road ends merge into one node of the police road graph (it already merges ends within 0.5 m). A port with no partner stays a
  dead end (a one-way lane with no `next` takes the car out of the world, a two-way one turns round), and is counted in
  `stream.stats().seams.unmatched`.
- **The bake's seam pass** (section 10) makes the heights agree: after both tiles of a seam are baked, the difference of their seam
  samples is split between them and faded out over 48 m into each tile, on everything that has a height (heightmap, ground and road
  meshes, collision, roads, lanes, paths, junctions, scenarios, props). So seam heights are bit-identical, ports match in height, and
  the change in grade is at most the difference over 48 m.

## 5. Collision per tile

| What | Per tile in the sim | Built |
|---|---|---|
| Ground (people, rays, wheels) | one plain heightfield | one job |
| Ground (cars' hulls) | the car-ground window, shared | one job when the window moves |
| Buildings | trimesh pieces of at most 4,096 triangles each, by 256 m chunk of their first vertex | one job each |
| Decks and piers | the same, twice (plain, and the `FIX_INTERNAL_EDGES` copy for hulls) | one job each |
| Footprints | a `FootprintIndex` of the tile's roofs; queries go to the tile that holds the point (and its neighbours within the query radius) | with the buildings |
| Street furniture, lamp poles, trunks | compound colliders per 40 m cell of the tile's own anchors and signal heads | 16 cells a job |

A piece of a tile is solid from the tick its job runs. A tile counts as **ready** once all its jobs have run: the streamer
loads tiles well before the player can reach them, and nothing is spawned on a tile until it is ready. A building straddling a
seam belongs to the tile that holds its footprint's first vertex (the pipeline writes it there; the other tile leaves it out).
Decks that cross a seam are cut at it; their hull copies are two trimeshes there (a known residual, like the deck seams in M1).

## 6. Props and anchors per tile

`props.json`, `scenarios.json` and signal heads hold only what stands in the tile's own cell (half-open: `minX <= x < maxX`,
`minZ <= z < maxZ`), so nothing is drawn or solid twice. Trees and furniture are drawn by one instanced set for the whole city
(the client hands them the union of the loaded tiles' anchors when the set changes), lamps by one lamp set, benches and bus
stops by one scenario-prop set; the sim keeps each tile's colliders apart so they drop with it.

## 7. Floating origin

- **What float32 gives.** A float32 position at 8 to 16 km from the origin is good to 1 mm, at 16 to 32 km to 2 mm. The M2 slice runs
  from Vinings (x -7.2 km, z -12.3 km) to Lake Claire (x +5.8 km), so every position is within 14.3 km of Five Points: 1 mm.
  Rapier stores positions as f32, so the sim needs no rebasing for M2, nor for the M3 warp (an 18 x 22 km world: the warp is
  anchored so the city origin is near its middle, |x|, |z| < 12 km).
- **What the runtime does now** (so that it can grow): every tile's static colliders are built from vertices relative to the tile's
  centre and placed with a translation; every drawn tile is a group at its centre holding geometry relative to it (the 2 x 2 chunk
  merge bakes positions relative to the tile, not to the city). The renderer already computes `modelView` in float64 (three.js
  composes matrices in JavaScript numbers), so a mesh's vertices only ever carry tile-local magnitudes.
- **Rebasing, when a world outgrows +-16 km** (multi-city, or a warp that does not keep the origin central):
  - *Renderer.* `RenderOrigin`: one group holds every world-space object and the camera, at `-origin`; the origin moves in steps of
    the tile size when the camera is more than 4 km from it. Shaders see positions within 4 km. Systems keep working in world
    coordinates (they set `camera.position`, positions under the group); only code that reads `matrixWorld` (shadow camera targets)
    adds the origin back.
  - *Sim.* `PhysicsWorld.origin`: Rapier holds positions minus the origin, and the sim's code reads and writes through
    `toPhys`/`fromPhys` at the few places that touch Rapier (bodies, colliders, rays, shape casts). A rebase happens at a tick
    boundary, in one step: every body's translation, every static collider's translation (a fixed collider moves without
    rebuilding its shape), and the car-ground window. Snapshots stay in world coordinates (float32 on the wire is then the limit,
    and is swapped for a tile-relative encoding at that point).
  Neither is built for M2; the rule above (tile-local vertices, translated colliders and groups) is what keeps them cheap to add.

## 8. Levels of detail and what is resident

| Ring | Desktop High | Medium | Low and phone | What it holds |
|---|---|---|---|---|
| **near** (sim and client, full) | tiles whose cell is within 900 m of the player | 800 m | 600 m | physics, graphs, AI, every mesh, trees, lamps, furniture, minimap, street names |
| near, dropped | beyond 1,150 m | 1,050 m | 850 m | (hysteresis) |
| **far** (client only) | within 4,500 m | 3,000 m | 2,000 m | the skyline mesh of `far.bin` |

- At most 3 x 3 near tiles on High (the player's tile and its eight neighbours when it stands near the middle; fewer near the edge of
  the grid), at most 6 on the phone (the near ring of 600 m reaches two cells only round a corner or an edge).
- `far.bin`: every building of the tile as a prism (its footprint simplified to at most 12 vertices, its height, a colour from its
  kind) plus the ground as a 33 x 33 grid; little-endian, see `src/shared/farTile.ts`. About 20 to 60 KB a tile. The client merges the
  far tiles into one mesh per 4 x 4 block of cells (few draws), drawn only where the tile is not near. The camera's far plane is
  raised to the far ring while a city streams (the depth buffer then resolves about 5 m at 3 km, enough for prisms in haze).
- Without `far.bin` a far tile is not drawn. The fixture makes its own.

### Budgets (iPhone 15 Pro is the floor)

| | Per 1 km tile (measured on the first baked M2 tiles: docs/perf.md, "Streaming") | Budget, phone | Budget, desktop |
|---|---|---|---|
| Download | about 3 MB (gzip about 1.4 MB) | | |
| Sim: JS heap (graphs, indices; the parsed files are let go once the tile is in) | 5.5 MB | | |
| Sim: Rapier WASM memory (heightfield, trimeshes, props) | 2.7 MB | | |
| Sim: typed arrays (the heightmap) | 1.5 MB; +1.6 MB at a 2 m heightmap | | |
| Sim, in all | about 10 MB | 6 tiles: 60 MB | 9 tiles: 90 MB |
| Client GPU buffers | about 6 MB | 6 tiles: 36 MB | 9 tiles: 54 MB |
| Client heap (anchors, indices, minimap atlas at 0.5 px a metre: 1 MB) | about 3 MB | 18 MB | 27 MB |
| Far tiles | 20 to 60 KB file, about 100 KB on the GPU, merged a mesh per 4 x 4 block | 16 tiles | 70 tiles |

Safari kills a tab long before the device runs out (a few hundred MB to about 1.5 GB depending on the device's memory); the game
keeps its whole footprint under 600 MB on the phone, the tiles under about 150 MB of it.

### Cost per frame

- **Sim.** A tile's integration is cut into jobs (building slices of 1,024 triangles with their footprints, whole deck structures,
  24 prop cells, the lane graph, the walk network, the seams, the main component, the car-ground window) and about 1,500 work units
  of them (about 1.5 ms on the dev box) run in a tick, after the systems; a job bigger than what is left of the budget waits for the
  next tick, where it runs alone. Measured on a real 1 km tile: 36 ms in all over 26 ticks, the worst tick 5.2 ms. The costs are counted in units (triangles, samples, colliders), not timed, so the
  same sequence of loads gives the same ticks on any machine: **the streamer is deterministic for a given sequence of player
  positions** (fetch completion is not: in the browser a tile is integrated on the first tick after it has arrived *and* its turn in
  the queue has come, so two runs can differ by when the network answered; the tests feed tiles synchronously).
- **Client.** At most one tile's meshes are added per frame, and the union rebuilds of trees, lamps and furniture are queued one a
  frame after a change. A far block is rebuilt in one frame (a few thousand prisms).

## 9. Unloading and the things on a tile

When a tile leaves the near ring (in the sim):
1. Ambient pedestrians, traffic cars (with their drivers), parked cars and police units on it, or with their route through it, are
   despawned the ordinary way (`entity:despawn` events). A car whose route only *ends* there keeps the part before it.
2. The player's own last car, if it is there, is frozen (made a fixed body) and woken when its tile is back; the sim never despawns it.
3. The tile's colliders are removed in one job, its graph elements are marked dead, and its slot is freed. A dead lane has length
   zero and no `next`; anything that still holds an edge id checks `graph.alive(e)` before using it.
4. Ragdolls on it are released and their people despawned.

Nothing the player can see is ever unloaded: the near ring is larger than every spawn and despawn radius (traffic removes cars
beyond 450 m, police units beyond 130 m when they stand down and spawn within 200 m, pedestrians beyond 135 m).

## 10. The pipeline: baking a grid

`tools/pipeline`: `npm run bake:m2 [-- --region downtown,midtown --only 0_-3 --skip-existing --jobs 2]`, under `flock
/tmp/hood-bake.lock`. Output `public/tiles/atlanta/m2/` (never the served M1 tile). Steps:

1. **Prefetch** (`npm run prefetch:m2`; idempotent, cached under `tools/pipeline/cache/atlanta/m2/`): per tile, the Overpass
   queries of a tile bake (roads and areas, tagged nodes, POIs, props, building parts), one request at a time with at least 2 s
   between requests, exponential backoff with jitter on 429, 504 and timeouts (up to 6 tries per endpoint, rotating the endpoints);
   3DEP per tile on a pixel grid aligned across the city (so two tiles sample the same pixels at their seam); Overture buildings
   and parts once for the whole slice's box, then cut per tile into the files the tile bake reads. A summary (what, how many
   bytes, what failed) goes to `cache/atlanta/m2/prefetch-report.json`.
2. **Bake each tile** with the existing per-tile bake (`bake(cfg)`, unchanged code) in a frame centred on its cell, with the grid's
   query margin, into `cache/atlanta/m2/build/<id>/`.
3. **Move it into the city frame**: add `(dx, dy, dz)` to every coordinate of every file (glTF node translations, `height.bin`,
   `collision.bin`, the JSON files), set `origin`, `baseElevation`, `bounds`, `id`.
4. **Keep only what is the tile's**: props, scenarios and signal heads outside the half-open cell are dropped (section 6).
5. **Seam pass** over every pair of neighbours (section 4): heights, then `seams.json` for both, and the match report.
6. **Far LOD**: `far.bin` from the collision mesh's building prisms and the heightmap.
7. **Index**: `index.json` with the content hashes.

The per-tile bake's own requirements for clean seams (for the world agents, not done by the orchestrator): no junction polygon
across a seam (end a junction's legs at it), decks cut at a seam with matching vertices on both sides, no turnaround connector at a
seam line, and buildings assigned by their first vertex. **Done (ground lane, 2026-10-16):**

- **Roads designed with the neighbours' roads.** A grid tile (`TileConfig.planMarginM`, the query margin less 32 m: 128 m) designs
  its road profiles, decks and carving over its cell and the margin beyond (a heightmap of the cell plus the margin from the same
  aligned DEM), and keeps the cell's part of the carved ground. Both tiles of a seam design the same roads over the same ground
  there, so a road and a deck that cross the seam meet at about one height before the seam pass (the six smoke tiles: seam
  deltas up to 1.74 m before, 0.043 m after; decks were 1.6 to 7.5 m apart). The deck ribbons are clipped at the bounds, so both
  sides have a vertex on the seam line at that height.
- **No junction polygon within 30 m of a tile's edge** (`buildRoads(..., { seamClear })`): the roads meet there as a junction
  without a polygon, and their lanes run on to the seam.
- **Lane ends on the seam** (`buildLanes(..., { bounds })`): a lane end within 0.3 m of a bounds line is put on it (lanes offset from
  a centreline that crosses the seam at an angle ended a few centimetres off it), and a road piece that ends on the bounds is kept
  however short (a way whose next node is 0.2 m across the seam).
- Smoke tiles: lane ports 45 matched and 24 not before, 71 and 6 after; the seam audit's lanes across seams 50 before, 106 after,
  with as many events at the seams as the same tiles merged into one world (the control): 6, 3 and 6 at 15, 25 and 35 m/s.

## 11. Hosting

- **Now**: Workers static assets. `public/tiles/atlanta/m2/` goes into `dist/` with the build (25 MiB per file: the biggest tile
  file is about 1.5 MB; the whole M2 slice of about 80 tiles is about 1,200 files and 250 MB, within the asset limits of the paid
  plan). `_headers` gives `index.json` `Cache-Control: no-cache` and the tile files `max-age=86400`.
- **Production**: R2 (`hood-tiles` bucket), served from a custom domain or a Worker route, CORS for the game's origin (the
  COOP/COEP pages need `Cross-Origin-Resource-Policy: cross-origin` on the tile responses):
  ```
  cities/atlanta/m2/index.json                       short cache; names the versions below
  cities/atlanta/m2/tiles/<id>/<version>/tile.json    immutable (Cache-Control: public, max-age=31536000, immutable)
  cities/atlanta/m2/tiles/<id>/<version>/...          the tile's files
  ```
  A re-bake uploads only the tiles whose content hash changed, then the index. Clients load the index from `?tiles=<url>`.

## 12. M3: the warp

The compression warp (README, "Compression") maps real coordinates to game coordinates. **Tiles are baked in game coordinates**,
so nothing in this contract or the runtime changes: the grid, the seams and the streaming all live in game space.
- `city.json` gains `warp: "warp.json"` (control points and zones). The tile bake projects its sources with the warp instead of the
  plain projection: positions are warped, while every object (a lane's width, a building's footprint, a tree) is placed at 1:1
  around its warped anchor, and streets are thinned by class (README).
- The query box of a game-space cell is the inverse image of the cell (plus margin) in real coordinates.
- A road crossing a seam between two compression zones has the same OSM id and the same warped position on both sides, so the seam
  ports match as before; the warp must be continuous (it is, by construction: piecewise smooth interpolation between control points).
- `index.json` gains `warp: { version }`, and `tile.json` gains `warp: { zone, scale }` (for the minimap's scale bar and the
  population tables).

## 13. Runtime API (for the code)

- `src/shared/city.ts`: `CityIndex` (parse `index.json`), `cellOf`, `tilesWithin`, the ring rules.
- `src/shared/seams.ts`: `seamPorts(tile, cell)`, `portKey`.
- `src/shared/fixture.ts`: `fixtureCity(opts)`, the 3 x 3 procedural test city (roads crossing every seam, hills, buildings, lanes,
  walk paths, props) as an index and a tile generator.
- `src/shared/farTile.ts`: encode and decode `far.bin`.
- `src/sim/stream/`: `TileStreamer` (rings, the job queue, slots, despawning), `TileSource` (fetch, or the fixture).
- `src/sim/World.ts` `PhysicsWorld`: `addTile`/`removeTile` as jobs, the car-ground window, footprints and ground height by tile.
- `LaneGraph`, `WalkGraph`, `RoadGraph`, `ScenarioIndex`: `addTile(slot, data)`, `removeTile(slot)`, `stitch`, `alive(e)`.
- `src/world/stream/`: `WorldStream` (per-tile views, the far blocks, the union of anchors), used by `main.ts` for `?tiles=`.
- Protocol: `SimInit.cityUrl` (or `'fixture'`), `SimReady.city`; the sim emits `stream:tile` events (`loaded`/`dropped`, id) and the
  client may draw ahead of them (it keeps its own rings by the camera).

## 14. What is built, and how it is checked (2026-10-16)

- **Sim** (`src/sim/stream/`): `TileStreamer` (rings, the job queue under a work budget, slots, stitching, drops, the composite
  tile), `StreamPhysics` (per-tile ground, building slices with their footprints, whole deck structures, prop cells, the car-ground
  window), `FootprintSet`, `TileSource` (HTTP and fixture). The lane graph, walk graph, police road graph and scenario index are
  tile-aware (`addTile`, `removeTile`, `stitch`); traffic, the pedestrians and the police follow the tiles through `streamListener()`.
  `Simulation.createCity` builds a sim on a city; a single-tile sim is built exactly as before.
- **Client** (`src/world/stream/`): `WorldStream` (near tiles' meshes, the far blocks, the city-wide sets), the fixture's meshes,
  the far meshes; `?tiles=fixture`, `?tiles=fixture:N` (cells -N..N) and `?tiles=<directory of index.json>` in `main.ts`.
- **Tests** (`tests/stream/`): the fixture's seams match (heights, lanes, walk); the graphs keep their ids and undo their seams;
  tiles load and drop round a moving player within the budget, with no leak over many laps, and the same moves give the same
  snapshots; the player is held over ground that is not in yet; the ground audit's own driver crosses every seam-crossing lane at
  15, 25 and 35 m/s with no air, launch, jolt, kick or hull push, with the car-ground window cut again under the car (and catches a
  12 cm step when one is put there); traffic, pedestrians and police chases cross seams. `npm run leaks` has a `stream` phase.
  `STREAM_COST=1 NODE_OPTIONS=--expose-gc npx vitest run tests/stream/cost.test.ts` measures a tile's cost in the sim;
  `npm run perf:stream` the browser; `npm run shots:stream` takes fixed views.
- **Not yet**: rebasing (section 7, not needed for M2), deck seams welded across tiles, the bake's seam-aware junctions (section 10),
  per-tile `heightmapFine` jobs (section 4), tile-local vertex positions in the client's 2 x 2 chunk merge, and draining the near
  tiles' prop and lamp sets per tile rather than as one union.

## 15. Rail transit across tiles (not built yet)

Each tile's `transit.json` (m1-tile-format.md) cuts the network to its cell from the one city-wide cache, so an M2 bake already
writes a transit layer per tile. What the streamed runtime still needs:

- **Route stitching.** A route leaving a tile (`exit` side) and its continuation entering the neighbour (`enter`) share the OSM
  relation id (`osm`) and meet on the seam line within centimetres (the track design runs 420 m past the cell, so both sides
  designed the same heights there). Key: `T|<axis><line>|<relation>|<ordinal>`, like the lane ports. The sim's trains would then
  run on a route made of the loaded tiles' pieces, and enter and leave at the edge of the *loaded area* (sources and sinks, as
  the freeways' traffic does), not at each tile's edge.
- **A station on a seam** (its hall, concourse or a corridor crossing into the neighbour) is laid out by the tile that holds its
  station node; the other tile must leave its tracks there to it (the hold box is the station's). Not handled yet: the bake would
  need the neighbour's plan.
- **Trains over unloaded ground**: a train whose cars are on a tile that dropped keeps running as state (it is not physics), its
  cars' bodies only where their tile is in.
- **Terminals**: a line that ends inside the grid (North Springs, the Airport) turns its trains round there; a single tile turns
  the player's train back at the tile's edge (an off-map terminus, with a fade).
- **The Airport station** is inside the Domestic Terminal (the airport region's own tiles): its platform level will attach to
  the terminal's interior through the station's `entrances` (street-level points) or a corridor the airport layer provides.
