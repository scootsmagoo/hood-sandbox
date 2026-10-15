# M1 tile format (contract between the pipeline and the client)

The world pipeline (`tools/pipeline/`) writes a baked tile. The client (`src/`) and the sim worker read it. Either side may propose a change, but the change goes into this file before the code changes.

M1 bakes one tile at **real 1:1 scale** (the compression warp arrives in M3).

## Coordinates

- 1 unit = 1 metre.
- **+X = east, +Y = up, +Z = south** (north is −Z), the three.js convention.
- Projection: `+proj=tmerc +lat_0=33.85 +lon_0=-84.3 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m` gives easting E and northing N.
- The tile origin is **Five Points, where Peachtree, Marietta and Decatur streets meet (33.7543 N, 84.3898 W; OSM node 69515924)**, projected to `(E0, N0)`. Game `x = E − E0`, `z = −(N − N0)`.
- Heights: `y = elevation_m − baseElevation`, where `baseElevation` is the ground elevation at the origin, so the ground near spawn is about y = 0.

## Files

The tile lives in `public/tiles/atlanta/m1-five-points/` and is served at `/tiles/atlanta/m1-five-points/`.

### `tile.json`

```jsonc
{
  "format": "hood-tile",
  "version": 1,
  "id": "atlanta/m1-five-points",
  "projection": "+proj=tmerc ...",          // as above
  "origin": { "lat": 33.7543, "lon": -84.3898, "E": -8319.964, "N": -10611.308 },   // E0, N0: the origin projected
  "baseElevation": 318.59,                   // metres above sea level at the origin
  "bounds": { "minX": -1000, "minZ": -1000, "maxX": 1000, "maxZ": 1000 },
  "heightmap": {
    "file": "height.bin",                    // little-endian Float32, row-major
    "cols": 501, "rows": 501,                // columns run along +X, rows along +Z
    "cellSize": 4,
    "minX": -1000, "minZ": -1000             // world position of sample [row 0, col 0]
  },
  "meshes": {                                // glTF binary; may use EXT_meshopt_compression
    "ground": "ground.glb",
    "roads": "roads.glb",
    "buildings": "buildings.glb"
  },
  "chunks": {                                // optional; how the .glb meshes are split (see "Chunks")
    "size": 256, "minX": -1000, "minZ": -1000, "cols": 8, "rows": 8,
    "groundLevels": [ { "lod": 0, "step": 1 }, { "lod": 1, "step": 4, "lower": 0.5, "skirt": 3 } ]
  },
  "collision": {                             // static world collision, excluding the heightmap
    "file": "collision.bin",                 // little-endian: Float32 positions [x,y,z]*, then Uint32 indices
    "vertexCount": 0, "indexCount": 0,
    "buildingTriangles": 0                   // the first this many triangles are buildings (walls, then the flat roof); the rest are decks and piers
  },
  "roads": "roads.json",                     // centrelines for later traffic and minimap work
  "junctions": "junctions.json",             // optional: junction polygons, signals, stop signs, crossings (see below)
  "lanes": "lanes.json",                     // optional: the directed lane graph traffic drives on (see below)
  "paths": "paths.json",                     // optional: the walk network pedestrians route over (see below)
  "scenarios": "scenarios.json",             // optional: where pedestrians sit, wait, queue and chat (see below)
  "spawns": {
    "player":  { "x": 0, "y": 0, "z": 0 },
    "vehicle": { "x": 0, "y": 0, "z": 0, "heading": 0 }   // radians; see "Spawns" below
  },
  "attribution": ["© OpenStreetMap contributors", "Overture Maps Foundation", "USGS 3DEP"],
  "sources": { "osm": true, "overtureBuildings": "2026-09-23.1", "elevation": "usgs-3dep" }   // optional: what the bake actually used ("flat" elevation = 3DEP was unreachable)
}
```

### `roads.json`

```jsonc
{ "roads": [ { "id": "osm:way/123", "class": "motorway|trunk|primary|secondary|tertiary|residential|service|...",
               "name": "Peachtree St NE", "lanes": 4, "oneway": false, "bridge": false, "layer": 0,
               "width": 14.0, "maxspeed": 56,    // `maxspeed` (km/h) only where OSM has one
               "derived": true,                  // `derived` only on bridges the pipeline made (see "Road profiles")
               "points": [[x, y, z], ...] } ] }
```

### Spawns

- `player`: `y` is the surface height at that spot (sidewalk top), so the client may drop the capsule a little above it. The player starts on foot here.
- `vehicle`: `y` is the road surface height. `heading` is the three.js `rotation.y` of an object that faces −Z at 0, so the forward vector is `(−sin h, −cos h)` in (x, z). Positive turns toward west.
- The two are meant to be a few metres apart: the vehicle parked at the right-hand curb of a street, the player on the nearest sidewalk. The sim puts a stand-in driver in that car (the player carjacks it), and parks more empty cars along nearby curbs using `roads.json`.

### Mesh details (client-facing)

- The `.glb` files use `EXT_meshopt_compression` and `KHR_mesh_quantization` (16-bit positions). Positions are quantized per mesh, so each mesh node carries a scale and translation. three's `GLTFLoader` needs `setMeshoptDecoder(MeshoptDecoder)`.
- All meshes carry `COLOR_0` (RGBA, normalized uint8, linear). Materials are white, so use `vertexColors: true`. Materials per file: `ground`; `road_asphalt`, `road_sidewalk`, `road_rail`, `road_concrete` (deck undersides, skirts, piers), `road_markings`; `bld_wall`, `bld_roof`, `bld_glass` (towers of 55 m and up, metallic).
- `ground.glb` is the heightmap at full resolution (`groundMeshStep` in `city.json`), triangulated with the diagonal from the south-west to the north-east corner of each cell, split into chunks with two levels of detail (see "Chunks"). The physics heightfield and `heightAt` (`src/shared/tile.ts`) cut each cell the same way, so they agree with the level 0 mesh exactly; a bilinear patch over the four corners would be up to a metre off on a twisted cell.
- `road_markings` holds lane lines, crosswalks and stop bars (white and yellow in the vertex colours). The old `road_crosswalk` material is no longer produced: crossings are zebra stripes in `road_markings`.
- At-grade road meshes sit 4–14 cm above the ground mesh (sidewalks 10 cm, motorways 10 cm, residential streets 6 cm; junction surfaces take the lift of their biggest road), so the sim can treat the heightmap as the road surface. Add `polygonOffset` to the road materials to hide depth fighting at distance, and a stronger one to `road_markings` (the client uses -2 for the roads and -4 for the markings).
- **Markings** lie 3 cm over the road they are on (14 cm over the ground for crosswalks, which may also lie on a sidewalk). They are one merged mesh per chunk. Centre lines are double yellow on two-way primary, secondary, tertiary and unclassified roads with an even number of lanes (a pair of solid yellow lines round the middle lane when the number of lanes is odd); white dashed lane dividers come from `lanes`; motorways and trunk roads (and their links) get solid white edge lines. Lines stop 5 m short of a junction. Zebra crosswalks are laid on every OSM crossing way (only where it lies on the road) and across every leg of a signalised junction that has no crossing within about 9 m; stop bars are laid on the approaches of signalised and stop-controlled junctions.
- **Junctions**: wherever three or more at-grade roads meet (nodes closer than 14 m along a road count as one junction) the surface is one polygon with rounded corners, and the road ribbons stop at its edge (`trim` in `junctions.json`). Roundabouts, motorway merges and junctions with legs less than 17 degrees apart keep the old overlapping ribbons and have no polygon. `roads.json` centrelines still run through junctions untrimmed.
- Tunnels (`tunnel=*`, negative `layer`) are not in the tile.

### Road profiles (the heightmap under the roads is not the raw 3DEP)

3DEP is a bare-earth model, so a street that crosses a freeway cut or a ravine used to drop into it (Auburn Avenue NE fell 2.7 m and climbed again within 10 m, about 30%). The pipeline now designs a vertical profile for every road on the ground (`tools/pipeline/src/world/profile.ts`) and changes `height.bin` to match it, so `height.bin` is the ground **after** cut and fill, and the sim drives on the designed surface:

1. Dips narrower than about 80 m along the roads are bridged in the design (a morphological closing over the road graph; dead ends are continued so slopes do not read as dips).
2. The heights are fitted to the terrain with a vertical curvature penalty and projected onto a grade limit per class (motorway 6%, links 8%, trunk 7%, primary and secondary 8%, service 10%, others 9%). Roads that share a node share its height.
3. Where the design stands more than 3 m over the terrain for at most 80 m the road is a **derived bridge**: a deck with underside, skirts, collision slab and piers like any mapped bridge, listed in `roads.json` with `bridge: true`, `layer: 1` and `derived: true`. Sidewalks beside such a bridge follow it. A longer or lower fill is an embankment.
4. Everywhere else the heightmap vertices within `halfWidth + 3 m` of a road centreline are set to the road height and blend back to the original ground over 9 m. Mapped bridges whose ends land on the ground take the designed height there (and pull the road they start from towards the height they need); the ground is cut away where it would stand higher than a deck.

The bake fails (`npm run verify`, or `npm run grades` in `tools/pipeline`) when more than 450 m of drivable centreline (about 109 km in the tile; measured on the heightmap and decks over 6 m windows) is steeper than 12%, or the worst grade exceeds 80%. Building footprints that stand on a street (not a service road) are cut by the street.

### Chunks

Each `.glb` holds one node (with one mesh and one primitive) per chunk and material, so the renderer can frustum-cull them: a view draws a few dozen chunks instead of the whole tile. The chunks are the squares of a grid over `bounds`: chunk `(cx, cz)` covers `x` from `minX + cx * size` and `z` from `minZ + cz * size`, `size` metres each (256 m by default, `chunkSizeM` in `city.json`; the last row and column are cut short by the bounds). `tile.json.chunks` describes the grid, and every node says which chunk it belongs to in its glTF `extras` (three.js puts them in `userData`):

```jsonc
{ "kind": "ground" | "asphalt" | "sidewalk" | "rail" | "concrete" | "markings" | "walls" | "roofs" | "glass_walls",
  "chunk": [cx, cz],
  "lod": 0 }                  // ground only
```

Node names are `<kind>_<cx>_<cz>` (ground: `ground_<cx>_<cz>_L<lod>`). A chunk with nothing of a material has no node for it.

- **Roads and buildings**: a triangle belongs to the chunk that holds its centroid, and is never cut, so a chunk's geometry can reach a few metres past its square. Use each mesh's own bounding sphere for culling (three.js computes it from the geometry), never the chunk square.
- **Ground levels of detail**: every chunk has two ground nodes, both covering the chunk's square. Level 0 is the full-resolution ground (`groundMeshStep`). Level 1 is every 4th sample of it (`step` in `groundLevels` counts heightmap cells): it is for far chunks. Show exactly one of the two per chunk. The client switches to level 1 when the camera is more than 400 m (times the tier's `lodScale`) from the chunk's square, with a little hysteresis. Level 1 differs from level 0 in two ways, so it never hides the roads that lie on the ground or shows cracks against a level 0 neighbour: its interior vertices are `lower` metres (0.5) below the terrain (the vertices on the chunk's border are not), and it has a vertical `skirt` of 3 m round its border (double-sided).
- Chunk edges are seamless within a level: normals come from the whole heightmap, and border vertices sit at the same positions in neighbouring chunks.
- A tile without `chunks` (an older bake) is one node per material; the client treats every node as a plain mesh.

### `collision.bin` contents

Building walls and roofs, plus elevated road decks (closed 1 m slabs, including footbridges and derived bridges) and bridge piers. At-grade roads are not in it; they are the heightmap.

- **Footprints are the drawn ones.** Each building is its outer ring *and its courtyards* (`collisionRings` in `tools/pipeline/src/world/collisionRings.ts`), every ring simplified to 0.15 m, so a courtyard is open in the collision mesh as it is in the drawn one (it used to be filled in: an invisible solid, with the inner walls left to walk through). Buildings that stand on a street are cut by it, in the drawn and the collision mesh alike.
- **Buildings first.** `collision.buildingTriangles` says how many triangles at the start of the mesh are buildings. Each building is its walls and then a flat roof (all three vertices at the roof height), triangulated over the footprint with the courtyards left out, so the sim recovers the footprints from the roofs and the outlines from the roof edges that belong to one triangle only (`src/shared/footprints.ts`). A trimesh has no inside a physics query can report; "is this person in a building" is answered from the footprints. A tile without the field has no footprints (the sim then trusts the physics alone).
- **Street furniture is not in it.** Signal poles (with their arms and lamp housings), benches and bus stops are solid too, but the sim makes them from `lanes.json` junction heads and `scenarios.json` points with the same functions the client draws them with (`src/shared/props.ts`: one list of boxes per kind and one placement function each), so what is drawn is what is hit. They are in their own collision group (`Group.Prop`): cars, people and bullets hit them, the camera arm and sight lines do not.

### `roads.json` notes

`bridge` is true for any way on a deck (`bridge=*` or `layer` of 1 or more); `layer` is then at least 1. `y` on bridge points is the deck surface. Points are simplified (0.25 m tolerance in 3D) and ordered along the direction of travel for one-way roads. Only drivable classes are listed (no footways or rail).

### `junctions.json`

For traffic, signals and the minimap. Roads are named by their `roads.json` id (a road that crosses a junction is one `roads.json` entry; `node` says where it meets the junction).

```jsonc
{
  "junctions": [ {
    "id": "j12", "x": 13.2, "y": 0.68, "z": -22.6,          // centre, surface height
    "control": "signals" | "stop" | "none",                  // signals: a highway=traffic_signals node on it or within 40 m up a leg
    "nodes": [123, 124],                                     // OSM nodes (several when close nodes were merged)
    "polygon": [[x, z], ...],                                // the surface, one decimal
    "legs": [ {
      "road": "osm:way/123", "node": 123,
      "dir": [dx, dz],                                       // unit vector pointing away from the junction
      "approach": true, "departure": true,                   // cars can arrive from / leave along this leg (one-way roads)
      "trim": 8.5,                                           // metres from the node to where the road starts
      "control": "signals" | "stop" | "none",                // what an approaching car faces
      "stopLine": [x, y, z] | null,                          // middle of the stop bar on the approach lanes
      "crosswalk": true                                      // a crosswalk was laid across this leg at the junction edge
    } ]
  } ],
  "signals": [ { "node": 1, "x": 0, "y": 0, "z": 0, "junction": "j12" | null } ],   // every highway=traffic_signals node on a road; null when no junction is within 40 m
  "stops":   [ { "node": 1, "x": 0, "y": 0, "z": 0, "direction": "forward" | "backward" | "both", "all": false, "junction": "j12" | null } ],   // highway=stop; direction is along the OSM way, `all` for stop=all
  "crossings": [ { "id": 123, "points": [[x, y, z], ...], "signals": false } ]      // OSM crossing ways (the zebra stripes follow these); `signals` when a node says crossing=traffic_signals
}
```

A stop sign applies to the leg it faces (`direction` along the way, from the sign to the first junction within 40 m) or, for `stop=all`, to every leg. Legs of a signalised junction that cars can arrive from all have `control: "signals"`. Phases are not baked: they are the sim's job, with `dir` and `approach` as input. `src/shared/tile.ts` has the type (`JunctionsData`).

## Rules

- The sim worker reads `tile.json`, `height.bin` and `collision.bin`, and `roads.json` when `tile.json` names one (optional: without it no cars are parked at the curb). It also reads `junctions.json`, `paths.json` and `scenarios.json` when named (optional: without `paths.json` there are no ambient pedestrians). It never parses glTF and never imports three.js.
- The client renders the `.glb` meshes and may also show the heightmap.
- Until a baked tile exists, the client falls back to a procedural test ground that has the same shape (a flat heightmap, some boxes, a spawn laid out like the real one, and a few street centrelines in `roads`).
- Baked tiles are build output. `public/tiles/` is gitignored and regenerated with `npm run bake` in `tools/pipeline/`.

### `lanes.json`

The directed lane graph that traffic drives on, generated by `tools/pipeline/src/world/lanes.ts` from `roads.json` and `junctions.json` (`src/shared/lanes.ts` parses it). Everything is in game coordinates, and points are flat `x, y, z` triples along the direction of travel, to 0.1 m.

```jsonc
{
  "format": "hood-lanes", "version": 1,
  "edges": [
    // a lane: one lane of one direction of the stretch of road between two junctions, offset from the centreline, trimmed back to the junction polygon
    { "t": 0, "road": "osm:way/123", "cls": "secondary", "dir": 1, "k": 0, "n": 2,
      "len": 98.3, "v": 15.6, "pts": [x, y, z, ...], "next": [812, 813],
      "left": -1, "right": 4,                      // the neighbouring lanes of the same direction (-1: none); lane changes happen between them
      "j": "j12", "leg": 2, "ctl": "signals",      // only when the lane ends at a junction: which, the leg it arrives on (an index into `junctions.json` legs), what a car there faces
      "bridge": 1 },                               // only on decks
    // a connector: the curve across a junction from the end of one lane to the start of another
    { "t": 1, "j": "j12", "from": 7, "to": 9, "turn": "s" | "l" | "r", "len": 14.2, "v": 11, "pts": [...], "next": [9],
      "leg": 2, "ctl": "signals",
      "c": [820, 822], "y": [820], "m": [] }       // conflicts (cross or merge): all of them; the ones this connector must yield to; the ones it contests by arrival order
  ],
  "junctions": [
    { "id": "j12", "x": 0, "z": 0, "control": "signals" | "stop" | "none", "implicit": 1,
      "legs": [ { "dir": [dx, dz], "approach": true } ],    // signalised junctions only: the `junctions.json` legs the signal groups are a function of
      "heads": [ { "leg": 2, "x": 0, "y": 0, "z": 0, "yaw": 1.2 } ] }   // signal heads on poles, one per approach (yaw: the face looks at cars arriving on `leg`)
  ],
  "stats": { "lanes": 3111, "connectors": 3995, "laneKm": 143.15, "junctions": 443, "implicitJunctions": 493, "conflicts": 3005, "skippedLegs": 1, "largestComponent": 0.59, "largestComponentStreets": 0.81 }
}
```

- **Lanes per direction** come from `lanes`: a one-way road has `lanes` lanes centred on the centreline; a two-way road has `lanes / 2` each way, and when `lanes` is odd the middle lane is a turn lane that carries no traffic. A one-lane two-way road has one each way. Lane `k` counts from the left (0 is next to the centreline of a two-way road). Traffic keeps right: in the direction of travel the lane lies on the right of the centreline. Lane width is `width / lanes`, between 2.6 and 4 m. Service roads, busways, living streets and tracks have no lanes.
- **Speed**: `maxspeed` (km/h) when `roads.json` has it, otherwise a posted speed for the class (motorway 29 m/s, trunk 24.6, primary 17.9, secondary 15.6, tertiary and unclassified 13.4, residential 11.2; links 0.7 times their class), cut on bends to what 3.2 m/s^2 of lateral acceleration allows (never below 3.5 m/s). A connector's `v` is the speed through the turn: at most 6.5 m/s for a right turn and 7.5 m/s for a left.
- **Junctions**: a junction with a polygon in `junctions.json` has its lanes trimmed back by each leg's `trim`. A road that ends inside a junction polygon is part of it. Where roads meet without a polygon (a way that changes id, a roundabout, a motorway merge, a side road ending on the middle of a road) the ends are matched within 0.75 m and the place is an implicit junction (`implicit: 1`, control `none`, no trim). A two-way road that ends in nothing (a cul-de-sac, the edge of the tile) gets a turnaround connector in an implicit junction `u<n>`. A one-way road that runs off the tile has a lane with no `next`: a car that reaches its end leaves the world.
- **Connectors** exist for every legal movement between a leg that cars arrive on and another that they leave along, never a U-turn (more than 150 degrees; a leg with nothing else to go to turns round). Straight: lane `k` to lane `min(k, m - 1)`. Right: the rightmost lane to the rightmost lane. Left: the leftmost to the leftmost. A lane the rules leave without a way on, or that nothing reaches, borrows a neighbour's.
- **Conflicts**: two connectors from different lanes conflict when their paths cross or they enter the same lane. `y` lists the connectors a connector must give way to: at a signal, a left turn gives way to the oncoming straight and right turns of its own group (movements of the other group are kept apart by the signal); at a stop-controlled junction, legs without a stop sign have the right of way; elsewhere the lower road class gives way, then left turns give way to straight and right. `m` lists those it contests by arrival order (all-way stops, equal roads).
- **Signals**: phases are not baked. `phaseOf(junction, t)` in `src/shared/signals.ts` gives the lamp of each approach group, as a pure function of the junction record and the time, so the sim, the client and pedestrians agree without snapshot bandwidth. `heads` say where the poles stand.
- **Connectivity**: `npm run verify` reports the share of lane length in the largest strongly connected component. A freeway that runs off the clipped tile cannot loop back, so the check judges surface streets (at least 70%). The sim only routes and spawns cars on edges of the largest component.


### `paths.json`

The walk network pedestrians route over, generated by `tools/pipeline/src/world/paths.ts` (`src/shared/walk.ts` parses it, `src/sim/peds/graph.ts` routes over it). Coordinates are the tile's; a node is `[x, y, z]` with `y` the walking surface (ground plus 10 cm, or the deck on a footbridge), to 0.01 m.

```jsonc
{
  "version": 1,
  "nodes": [ [x, y, z], ... ],
  "attrs": [ { "kind": "sidewalk", "width": 1.8 },
             { "kind": "crossing", "width": 3,
               "crossing": { "id": 123, "marked": true, "signals": true, "junction": "j12", "leg": 2, "road": "osm:way/456" } },
             { "kind": "crossing", "width": 3, "bridge": true } ],
  "edges": [ a, b, attr,  a, b, attr, ... ],             // flat triples: two node indices and an index into `attrs`; an edge is undirected
  "stats": { "nodes": 14245, "edges": 15757, "lengthM": 134700, "components": 22, "largestShare": 0.983, ... }
}
```

- `kind`: `sidewalk` (a mapped `footway=sidewalk`), `synthetic` (made by the pipeline where a street has no mapped sidewalk), `footway`, `pedestrian` (a pedestrian street), `crossing`, `island` (a traffic island between two crossings), `link` (made by the pipeline to join a dead end to the network), `steps`.
- **Where it comes from.** Every mapped sidewalk, footway, pedestrian street, path, set of steps, crossing and traffic island the pipeline parses (`osm.ts`) inside the tile. Where a drivable street (primary to residential and living streets, not on a deck) has no mapped sidewalk within 3.6 m of a curb offset, a synthetic one is added in runs of at least 8 m, 2 m outside the road's half width (`SYNTHETIC_OFFSET`), and the same runs are drawn as 2 m ribbons in the sidewalk mesh (`road_sidewalk`) so there is something to look at. The pipeline also lays a crossing across every junction leg that has no crossing of its own within 9 m (`marked` when the leg has a painted zebra) where both ends have a sidewalk within 4.5 m, so the network connects round every junction.
- **Clear of buildings.** Vertices are resampled to 3 m, vertices inside a footprint are dropped (the path is cut there), and vertices closer than 0.5 m to a wall are pushed out to 0.55 m. Islands shorter than 40 m are dropped, dead ends within 1.6 m of another piece (9 m for another component, if the line between is clear of walls and roads) are joined, and straight runs are merged.
- **Crossings** carry the road they cross and, where the crossing is at a junction, the junction (`junctions.json` id) and the **leg** (an index into that junction's `legs`) whose lanes the walker crosses. `signals` is true when the OSM node says `crossing=traffic_signals` or the junction is signalised. A walker crosses leg `L` of junction `J` on a walk light: `walkState(J, L, t)` in `src/shared/signals.ts` (the same function traffic uses for the cars' lights). A crossing with no light (or `junction: null`) is crossed in a gap in the traffic.
- **Connectivity** is reported by `npm run verify` (components, the largest component's share of the length, the distance from the player spawn to it). The Five Points tile is 134.7 km in 22 components, 98.3% of it one piece.
- The sim reads it optionally: a tile without it has no ambient pedestrians.

### `scenarios.json`

Places where a pedestrian stands about doing something, so the sim can spawn people already doing it. Generated by `tools/pipeline/src/world/scenarios.ts` from a cached Overpass query (nodes and ways: benches, bus stops and platforms, ATMs, restaurants, cafes, bars, fast food, shops, fountains, artwork, squares) plus synthesised fill. If the Overpass query cannot be fetched (it fails often: the pipeline retries with a backoff and then gives up), everything is synthesised.

```jsonc
{ "version": 1,
  "points": [ { "id": "s12", "type": "bench", "x": 10.0, "y": 0.05, "z": -4.5, "yaw": 1.57, "cap": 2, "src": "osm" } ],
  "stats": { "total": 2025, "byType": { "bench": 44, ... }, "osm": 365, "synth": 1660, "poiData": true } }
```

- `type`: `bench` (sit; the client draws a bench there), `busstop` (wait; the client draws a stop), `atm` (one person at the machine, facing the building), `shopfront` (browse a window; a pair chats), `eatery` (wait or chat at a restaurant, cafe or bar), `lawn` (sit or chat in a park, away from the paths), `plaza` (chat, or photograph), `corner` (wait at the kerb of a signalised crossing, on the phone or chatting).
- `yaw` is the way people face, as a ped's yaw: forward is `(sin yaw, cos yaw)` in `(x, z)`. `cap` is how many people use it at once. `src` is `osm` (from the map) or `synth`.
- Points on a sidewalk are on the walk network (snapped to it), clear of footprints by 0.4 m. POIs inside a building are moved out to the nearest sidewalk and face the building.
