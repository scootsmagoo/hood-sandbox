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
  "props": "props.json",                     // optional: tree, street lamp and street furniture anchors (see below)
  "landmarks": "landmarks.json",             // optional: the city pack's landmarks in the tile, and the hand-built hero models (see "Hero landmarks")
  "transit": "transit.json",                 // optional: the rail lines, stations, tunnels and viaducts (see "transit.json"); it names its own transit.glb and transit.bin
  "meshFormat": 3,                           // optional: 2 when the .glb meshes carry the attributes of "Mesh attributes (meshFormat 2)", 3 when the buildings also carry `_LOOK` ("Building appearance (meshFormat 3)"); absent in an older bake
  "buildingKinds": ["generic", "office", ...],   // optional: the names of the building kind ids, in id order (see below)
  "buildingMaterials": ["unknown", "brick", ...], // optional (meshFormat 3): the names of the facade material ids (`_LOOK.x` on walls), in id order
  "buildingStyles": ["unknown", "classical", ...], // optional (meshFormat 3): the names of the style ids (`_LOOK.y`), in id order
  "roofMaterials": ["membrane", "metal", ...],    // optional (meshFormat 3): the names of the roof material ids (`_LOOK.x` on roofs), in id order
  "landClasses": ["urban", "grass", ...],        // optional: the names of the ground class ids, in id order
  "spawns": {
    "player":  { "x": 0, "y": 0, "z": 0 },
    "vehicle": { "x": 0, "y": 0, "z": 0, "heading": 0 }   // radians; see "Spawns" below
  },
  "attribution": ["© OpenStreetMap contributors", "Overture Maps Foundation", "USGS 3DEP"],
  "sources": { "osm": true, "overtureBuildings": "2026-09-23.1", "overtureParts": 335, "osmProps": true, "elevation": "usgs-3dep" }   // optional: what the bake actually used ("flat" elevation = 3DEP was unreachable; overtureParts is how many building parts, osmProps whether the tree and lamp query worked)
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
- All meshes carry `COLOR_0` (RGBA, normalized uint8; RGB linear). **From `meshFormat` 2 the alpha is the baked ambient occlusion** (255 = open sky, lower = occluded; see below), where it used to be 255 everywhere. The materials are opaque, so three.js ignores it unless a shader reads `vColor.a`. Materials are white, so use `vertexColors: true`. Materials per file: `ground`; `road_asphalt`, `road_sidewalk`, `road_rail`, `road_concrete` (deck undersides, skirts, piers), `road_markings`; `bld_wall`, `bld_roof`, `bld_glass` (curtain-wall towers: kind 2, towers of 55 m and up unless the data says masonry or civic; metallic).
- `ground.glb` is the heightmap at full resolution (`groundMeshStep` in `city.json`), triangulated with the diagonal from the south-west to the north-east corner of each cell, split into chunks with two levels of detail (see "Chunks"). The physics heightfield and `heightAt` (`src/shared/tile.ts`) cut each cell the same way, so they agree with the level 0 mesh exactly; a bilinear patch over the four corners would be up to a metre off on a twisted cell.
- `road_markings` holds lane lines, crosswalks and stop bars (white and yellow in the vertex colours). The old `road_crosswalk` material is no longer produced: crossings are zebra stripes in `road_markings`.
- At-grade road meshes sit 4–14 cm above the ground mesh (sidewalks 10 cm, motorways 10 cm, residential streets 6 cm; junction surfaces take the lift of their biggest road), so the sim can treat the heightmap as the road surface. Add `polygonOffset` to the road materials to hide depth fighting at distance, and a stronger one to `road_markings` (the client uses -2 for the roads and -4 for the markings).
- **Markings** lie 3 cm over the road they are on (14 cm over the ground for crosswalks, which may also lie on a sidewalk). They are one merged mesh per chunk. Centre lines are double yellow on two-way primary, secondary, tertiary and unclassified roads with an even number of lanes (a pair of solid yellow lines round the middle lane when the number of lanes is odd); white dashed lane dividers come from `lanes`; motorways and trunk roads (and their links) get solid white edge lines. Lines stop 5 m short of a junction. Zebra crosswalks are laid on every OSM crossing way (only where it lies on the road) and across every leg of a signalised junction that has no crossing within about 9 m; stop bars are laid on the approaches of signalised and stop-controlled junctions.
- **Junctions**: wherever three or more at-grade roads meet (nodes closer than 14 m along a road count as one junction) the surface is one polygon with rounded corners, and the road ribbons stop at its edge (`trim` in `junctions.json`). Roundabouts, motorway merges and junctions with legs less than 17 degrees apart keep the old overlapping ribbons and have no polygon. `roads.json` centrelines still run through junctions untrimmed.
- Road tunnels (`tunnel=*`, negative `layer`) are not in the tile. The subway (tunnels, trenches, viaducts and stations) is never in the roads: it is the transit layer (`transit.json`).

### Road profiles (the heightmap under the roads is not the raw 3DEP)

The 3DEP image is requested with pixels square in degrees (2 m / 110574 degrees each way, as the M2 grid asks), the box the query box's centre plus or minus whole pixels: `exportImage` makes the pixels square in degrees whatever size is asked for, and the M1 request used to ask for metre-square ones and label the image with a box it did not cover (the terrain was squeezed north to south by 0.84 about the centre, up to 217 m and several metres of height off at the edges; baked tiles before 2026-10-16 have it). The image's own georeferencing is used when the file has it. 3DEP is a bare-earth model, so a street that crosses a freeway cut or a ravine used to drop into it (Auburn Avenue NE fell 2.7 m and climbed again within 10 m, about 30%). The pipeline now designs a vertical profile for every road on the ground (`tools/pipeline/src/world/profile.ts`) and changes `height.bin` to match it, so `height.bin` is the ground **after** cut and fill, and the sim drives on the designed surface:

1. Dips narrower than about 80 m along the roads are bridged in the design (a morphological closing over the road graph; dead ends are continued so slopes do not read as dips).
2. The heights are fitted to the terrain with a vertical curvature penalty and projected onto a grade limit per class (motorway 6%, links 8%, trunk 7%, primary and secondary 8%, service 10%, others 9%). Roads that share a node share its height, and a lesser road (class, then width) is held level with a greater one it meets over the greater one's carriageway (its nodes within 1.1 half widths of the junction), so it starts its climb at the kerb. **Mapped car bridges are designed in the same solve** (their nodes fitted to the height that clears what passes under them, at a third of a ground node's weight), so a bridge meets the roads it lands on and forks from at their height, with their grade limits. Constraints, all projected with the grades: a car deck stands a car's clearance and its slab (6.1 m; 4.1 m over a path, 7.1 m over a railway) over every way it crosses, over the crossed way's width and 3 m either side, the deck climbing and the road under it dipping by their weights; side-by-side carriageways (closer than their half widths together, within 45 degrees, not joined) are held to one height, within 0.05 m where they overlap most and 0.65 m where they barely do (not a deck and a way it crosses, nor a deck over a road it runs along); vertical curves are at least the stopping-sight-distance crest K and comfort sag K of the way's design speed (posted limit, else the class's), never sharper than a radius of 180 m, and the same across the node where one way ends and the next carries on (within 35 degrees). Where those cannot all be kept, the curves within 40 m give way to the 180 m radius and the ties there become wishes, for up to four rounds (this tile: 1681 curves and 587 ties; the worst clearance is 0.02 m short). A mapped car bridge the design keeps within 1 m of the terrain all along, with nothing to clear, is built as a road on the ground (17 in this tile).
3. Where the design stands more than 3 m over the terrain for at most 80 m, and something passes under it (a road, a railway or a path at least 2.5 m lower that crosses it in plan) or another road runs close beside it (within both half widths and 3 m) more than 1 m higher or lower, the road is a **derived bridge**: a deck with underside, skirts, collision slab and piers like any mapped bridge, listed in `roads.json` with `bridge: true`, `layer: 1` and `derived: true`. Sidewalks beside such a bridge follow it. A fill with nothing under or beside it (most often the bare-earth model's hollow where an overpass was taken out), and a longer or lower one, is an **embankment**: the ground is filled to the design (up to 15 m in this tile). A derived bridge whose end the carving leaves lower than the design grows a node at a time (5 m) until it lands.
4. Everywhere else the heightmap vertices within `halfWidth + 3 m` of a road centreline are set to the road height and blend back to the original ground over 9 m (where corridors overlap, a vertex takes their weighted mean, each road weighted as at its centre out to three quarters of its half width, so a wide carriageway's outer lanes follow it rather than a narrower road beside it). Then the corridor (the vertices within 3 m of a road's edge) is smoothed: 16 rounds of a Laplacian over its own vertices only (the terrain beside it does not pull it), at most 0.1 m of change, and not within 7 m of where a deck lands. The ground is cut away (to 1.3 m under the slab, within 1.5 m of the deck and blending out over 3 m) where it would stand more than 0.15 m higher than a deck, mapped or derived; not inside another road's carriageway, not round a junction of three or more ways, and not within 4.5 m of where a deck lands (its abutment).

The bake fails (`npm run verify`, or `npm run grades` in `tools/pipeline`) when more than 450 m of drivable centreline (about 109 km in the tile; measured on the heightmap and decks over 6 m windows) is steeper than 12%, or the worst grade exceeds 80%. Building footprints that stand on a street (not a service road) are cut by the street, and every footprint is cut by the lanes and junction curves of `lanes.json` (1.3 m either side of the path, an octagon at every bend), so no car's path runs into a building. `npm run verify` also runs the ground audit (`docs/ground-audit.md`) as a gate: every lane driven by a physics car at 15, 25 and 35 m/s, the surfaces under the lanes, the lanes and roads against the buildings.

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

- **Decks meet the ground.** A deck's slab top is its road surface: a mapped deck's height, a derived bridge's design height (it is *drawn* its road's lift, 6 to 10 cm, higher, as the roads on the ground are). An end within 1.5 m of the ground (on its own, or a joint of decks within 0.6 m of the ground: every deck there alike) is brought onto the ground, the move fading out over up to 20 m and adding at most 6% of grade; its two corners then go 3 cm under the ground (a corner over ground more than 0.6 m lower, the side of the embankment it stands on, stays), so a wheel passes from the heightmap to the deck where the two cross and no slab edge stands proud of the road. Where car decks overlap (a crossing or a fork on a bridge, two ways meeting at an angle), each vertex takes the weighted mean of the decks at its level (within 0.6 m) whose carriageway is within 2 m of it and that are at least as great a road (class, then width); a lesser deck's vertex on a greater deck's carriageway (within 1.5 m of its height) takes that carriageway's height, and a lesser deck that joins a greater one at a T (its whole cross-section on the greater deck) stops 0.5 m inside the greater one's kerb. Where two deck pieces end at the same point, a **cap** (the convex hull of their end corners, drawn and solid) fills the wedge between their square ends.
- **One welded top per deck level.** The car decks' collision tops are not their ribbons: every level (decks that touch or overlap within 0.35 m of each other's height) is one mesh on a 4 m grid aligned with the heightmap (a square wholly on the deck is two triangles cut like the ground's; one on its edge is the part on the deck, triangulated), every vertex shared, so the internal-edge fix covers its seams (`tools/pipeline/src/world/deckWeld.ts`). In a cell, ribbons of a level that run side by side at different heights (a ramp still touching the viaduct it has left) are triangulated apart, so no triangle spans the two. Two levels that overlap less than 2.5 m apart (a car does not fit between) split the overlap at the midline between their centrelines, each keeping its own side; where the centrelines meet, the greater road keeps it. The ribbons keep their sides and undersides.
- **Barriers.** Every car deck has a solid barrier along both edges of its carriageway (the deck is the carriageway and its shoulders): 0.95 m tall over the deck, 0.3 m thick, standing outside the edge, its inner face vertical with no slope at its foot (a car that hits it is turned along it, not lifted), drawn in concrete exactly as it is solid (`road_concrete` and `collision.bin`). Not where the deck carries on sideways into another car deck at its level (a fork, a merge, a road joining it), nor where the ground beside the edge is within 0.6 m of the deck (where it lands). `npm run verify` checks that every lane on a deck keeps a car's half width and 0.33 m inside its barriers, and that no deck is more than 2.5 m a side wider than its lanes.
- **Piers** stand clear of every carriageway, a lower deck's included (the whole pier, not its centre). A sidewalk's slab beside a derived bridge is not solid where it overlaps a car deck.
- **The sim builds it in parts** (`src/sim/World.ts`): the buildings (the first `buildingTriangles`), and the decks and piers twice, a copy with Rapier's `TriMeshFlags.FIX_INTERNAL_EDGES` that only cars' hulls meet and a plain copy for everything else (the heightfield likewise: see `docs/ground-audit.md`). A tile without `buildingTriangles` is all walls.

- **Footprints are the drawn ones.** Each building is its outer ring *and its courtyards* (`collisionRings` in `tools/pipeline/src/world/collisionRings.ts`), every ring simplified to 0.15 m, so a courtyard is open in the collision mesh as it is in the drawn one (it used to be filled in: an invisible solid, with the inner walls left to walk through). Buildings that stand on a street are cut by it, in the drawn and the collision mesh alike.
- **Buildings first.** (A hero landmark's hull prisms are buildings of this part; see "Hero landmarks".) `collision.buildingTriangles` says how many triangles at the start of the mesh are buildings. Each building is its walls and then a flat roof (all three vertices at the roof height), triangulated over the footprint with the courtyards left out, so the sim recovers the footprints from the roofs and the outlines from the roof edges that belong to one triangle only (`src/shared/footprints.ts`). A trimesh has no inside a physics query can report; "is this person in a building" is answered from the footprints. A tile without the field has no footprints (the sim then trusts the physics alone).
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

### Mesh attributes (meshFormat 2)

Everything in this section is **optional and additive**: a `.glb` of an older bake lacks it, and a renderer that ignores it draws the same meshes as before (same materials, same node names, same chunks, `COLOR_0` as the albedo). A shader that uses an attribute must cope with its absence (three.js gives a missing attribute the value 0). Custom attributes are glTF `_NAME` attributes; three.js's `GLTFLoader` lower-cases them (`_BLD` becomes `geometry.attributes._bld`) and keeps `TEXCOORD_1` as `uv1`. Integer attributes are stored as plain (not normalized) `uint8` or `uint16`, so a shader reads the integer value as a float. Positions are 16-bit as before; `TEXCOORD_n` stay `float32` because they are in metres. Texture coordinates are on a 1/32 m grid.

**Buildings** (`walls`, `glass_walls` and `roofs` nodes; the three kinds keep their materials and chunks):

| Attribute | Type | walls, glass_walls | roofs |
|---|---|---|---|
| `TEXCOORD_0` | float32 x2 | `u` = metres along the footprint ring from the ring's first vertex, **continuous from one edge to the next** (the next quad starts at the u the last one ended at; it restarts at 0 on the ring's first vertex, and each hole is its own ring); `v` = metres above the building's ground datum (the lowest ground under the footprint). The bottom vertices are at `v = -0.3` (the wall goes 0.3 m into the ground), a floating part's at its `min_height`. So `uv` is an exact box projection of the wall: one texture repeat per N metres is `uv / N`. | flat surfaces: metres along (`u`) and across (`v`) the footprint's oriented bounding box, from its corner (so a pattern lines up with the building); pitched slopes: metres along the ridge (`u`) and up the slope (`v`), measured in the slope's plane; parapet, gable and equipment faces: as a wall. |
| `COLOR_0.a` | uint8 | ambient occlusion, see below | the same (1 on the open roof; the parapet's inner face fades to about 0.55 at its foot) |
| `_WALL` | float32 x4 | `(u0, len, v0, v1)` of the wall quad this vertex belongs to: where it starts along the ring, its length, and its bottom and top in `v` (without the 0.3 m skirt). Every vertex of a quad has the same value, so a shader can lay out whole windows without looking at the neighbours. | not present |
| `_BLD` | uint8 x4 | `(kind, era, floors, band)` of the building piece: `kind` is a building kind id, `era` 0 unknown, 1 before 1930, 2 1930 to 1959, 3 1960 to 1989, 4 1990 or later; `floors` is the number of upper floors of this piece (above the band, at least 1, at most 255), so `(v1 - v0 - band / 10) / floors` is the floor height; `band` is the height of the ground floor band, **in decimetres** (storefront, lobby or podium floor; 0 for none), counted up from `v0`. | the same values as the walls of the same piece |
| `_BID` | uint16 x2 | `(hash, flags)`: `hash` is a stable 16-bit hash of the building's id (seed per-building variation with it; it does not change when the bake does, unless the id does); `flags` is a bit set: 1 pitched roof, 2 parapet, 4 this is a part of a building made of several (a setback tower, a podium), 8 named building, 16 era from data (else inferred), 32 has a courtyard, 64 floating (the part starts above the ground), 128 kind from data (a class, an OSM tag or a name; else inferred from the height and the plan) | the same |
| `_SRF` | uint8 x4 | not present | `(surface, shape, equipment, slope)`: `surface` is a roof surface id, `shape` the roof shape id of the piece, `equipment` the rooftop equipment id on equipment surfaces, `slope` the pitch in degrees on pitched slopes |

Kinds (`_BLD.x`, `buildingKinds` in `tile.json`): 0 generic (an unclassified block), 1 office (frame or concrete tower, ribbon or punched windows), 2 glass (glass curtain wall: also drawn with the `bld_glass` material), 3 brick (brick or masonry commercial and loft buildings), 4 parking (open-deck garage), 5 retail (shopfronts, one or two storeys), 6 civic (government, courts, libraries, schools, universities, hospitals, museums), 7 religious, 8 industrial (warehouse, depot, utility), 9 residential (apartments, dormitories, hotels, lofts), 10 house (houses and terraces: pitched roofs), 11 small (shed, kiosk, guardhouse, gazebo, shelter), 12 venue (stadium, arena, convention hall, aquarium).

Roof surfaces (`_SRF.x`): 0 flat roof, 1 pitched slope, 2 parapet inner face, 3 parapet cap, 4 gable end (a vertical triangle or trapezoid under a pitched roof), 5 equipment (the sides and top of a rooftop box or tank), 6 soffit (the underside of a part that starts above the ground), 7 dome. Roof shapes (`_SRF.y`): 0 flat, 1 gabled, 2 hipped, 3 pyramidal, 4 dome, 5 skillion (one slope). Equipment (`_SRF.z`): 0 none, 1 air handler (a box), 2 water tank (an octagonal drum), 3 stair or lift bulkhead, 4 penthouse or crown.

- **Floors and heights.** `floors` comes from Overture `num_floors`, OSM `building:levels` (less `building:min_level` for a part that starts above the ground), Wikidata or the known-heights list when the data fits the height (a floor between 2.6 and 5.5 m; up to 7 m for a tower whose height and floors are both from the known list), otherwise it is derived from the height with a floor height that depends on the kind and the era (garages about 3 m, offices 4 m, pre-1930 masonry a quarter metre more, housing 3.1 m, shopfronts 4.5 m). A tower's **crown** (see below) is not floors: `floors` and the floor height leave it out.
- **Roofs.** A flat roof with a parapet (buildings over 6 m): the wall quad rises to the parapet top, which is the building's `height` as before; the roof surface sits 0.7 to 1.2 m below it and the parapet's inner face is in the `roofs` node (`surface` 2; a cap, `surface` 3, only on buildings under 12 m, to save triangles). Rooftop equipment is real geometry on flat roofs over 300 m2 (air handlers, a few water drums, stair and lift bulkheads, and a penthouse on towers over 60 m: boxes and 6-sided drums, `surface` 5, seeded by the building id, so they do not move between bakes). Small low-rise buildings and any building whose OSM `roof:shape` or Overture `roof_shape` says so get a gabled, hipped, pyramidal, skillion or domed roof; the walls stop at the eaves and the roof reaches the building's `height` at the ridge. Pitched roofs are generated for footprints close to a rectangle; others stay flat.
- **Parts.** Where Overture has `building_part` features for a building they replace its single prism: each part is extruded between its `min_height` and `height` (its own roof, its own `floors`), taller parts hide the walls they cover, and the part of the footprint that no part covers is a prism of its own at the building's height (or at a podium height when the building's height is the tower's). Parts are cut by the roads like footprints are.
- **Classification.** The kind comes from, in order: the name (deck and garage, church, stadium, civic words), the Overture `class` and `subtype` and the OSM `building`, `amenity`, `shop` and `office` tags, then the facade material, the year (`start_date`, `building:year_built`), the height and the plan. `_BID.y` bit 128 says which of the two it was. The `era` is the year when the data has one (bit 16), else a guess from the kind.
- **Skybridges.** An OSM `building=bridge` footprint (a covered walkway between two buildings; Overture has them as footprints with no height, 11 in this tile) is not a building down to the ground: it is one **floating piece**, a glazed tube (kind glass, one floor, flat roof, no ground band) from its `min_height` to its `height`. The mapped `min_height` / `building:min_level` is used when there is one (and a mapped height that fits a walkway, 2.5 to 7 m above it); otherwise the tube's underside is 7 m over the **highest ground under the footprint** (a second-floor link) and the tube is 4 m tall (`skybridgeHeights` in `world/buildings.ts`). A footprint tagged `bridge` that is 30 m tall or more is a building, not a walkway, and stays one. A skybridge is **not cut by the road** it crosses (`clip.ts`), is not in the footprints the walk network, the spawns and the props avoid, and shades the ground under it like a deck in the baked occlusion.
- **Collision is unchanged** (except for a skybridge, below). `collision.bin` is still one prism per footprint: its walls and a flat roof at the **highest** point of the drawn building (the ridge of a pitched roof, the top of the tallest part), with the courtyards, so `buildingTriangles` and the footprints the sim recovers from the roofs are what they were. The drawn building can be lower than its collision prism at the eaves of a pitched roof and over the lower parts of a stepped tower. **A building that is only floating pieces (a skybridge) is solid only from its lowest underside up**: its prism is walls and a roof from the underside to the top, with no floor and nothing below, so cars and people pass under it (`PlannedBuilding.solidBaseH`); the sim's footprint index reads the walls' lowest corner as the base, so somebody on the street under it is not inside it.

**Roads** (`asphalt` and `sidewalk` nodes):

| Attribute | Type | Meaning |
|---|---|---|
| `TEXCOORD_0` | float32 x2 | a ribbon: `u` = metres across from the left edge (looking along the direction of travel; 0 to the width), `v` = metres along the piece from its start; junction surfaces: the world position `(x, z)` in metres. |
| `TEXCOORD_1` | float32 x2 | `(halfWidth, kerb)`. A ribbon: `halfWidth` is half the width in metres and `kerb` is 0 on a carriageway (the distance to the nearest edge is `halfWidth - abs(u - halfWidth)`, so a shader gets kerb and gutter wear without further data); on a sidewalk `kerb` is +1 when the road is on its right-hand edge, -1 when it is on the left, 0 when it is neither or both. A junction surface: `halfWidth` 0 and `kerb` is the distance in metres to the edge of the junction polygon at the vertex (0 on the rim). |
| `COLOR_0.a` | uint8 | ambient occlusion |

`road_concrete` (deck undersides, skirts, piers), `road_rail` and `road_markings` have no texture coordinates; their `COLOR_0.a` is the ambient occlusion of the vertex (the underside of a deck is dark).

**Ground** (`ground` nodes, both levels of detail):

| Attribute | Type | Meaning |
|---|---|---|
| `_LAND` | uint8 x4 | `(class, grass, dirt, plaza)`: `class` is the ground class id of the vertex; the other three are blend weights 0 to 255 (a 3x3 smoothing of the classes round the vertex) of lawn, bare earth and gravel, and paving. The rest (255 minus their sum) is plain urban ground or asphalt. Interpolating the weights across a triangle is right; interpolating the id is not (read it flat or ignore it). |
| `COLOR_0.a` | uint8 | ambient occlusion |

Ground classes (`_LAND.x`, `landClasses` in `tile.json`): 0 urban, 1 grass (parks, gardens, lawns, meadows, institutional grass), 2 woodland, 3 dirt (construction, brownfield), 4 plaza (pedestrian squares and areas), 5 parking lot, 6 industrial yard (gravel), 7 rail ballast, 8 water, 9 sports pitch or playground, 10 cemetery, 11 residential yard, 12 commercial hardscape. `COLOR_0` of the ground is the colour of the class, as before.

**Ambient occlusion** (`COLOR_0.a`): a sky-view estimate from a height raster of the buildings (1.5 m cells): 16 horizon directions, to 120 m, so a street canyon is darker than a plaza and the foot of a tower darker than its top. Ground, road and sidewalk vertices get it at their own height, wall vertices at theirs (the base of a wall facing a narrow street is dark, the top is not), plus a contact term within about 3 m of a wall, and 0.5 under a deck. The range is about 0.25 to 1. It is meant to multiply the **indirect** light (the hemisphere or sky term), not the albedo: that is why it is in the alpha and not in the colour.

### Building appearance (meshFormat 3)

meshFormat 3 adds one attribute to the building meshes and three name lists to `tile.json`; everything else is as in meshFormat 2, so a renderer that ignores `_LOOK` draws what it drew before (the colours were always `COLOR_0`, and from meshFormat 3 they are the data's where the data has them). A shader that uses it must cope with its absence (a missing `_LOOK` reads as all zeros: material and style 0, "unknown", which means "lay the wall out by its kind alone").

| Attribute | Type | walls, glass_walls | roofs |
|---|---|---|---|
| `_LOOK` | uint8 x4 | `(material, style, band, flags)` | `(roofMaterial, style, material, flags)` |

- `material` is a facade material id (`buildingMaterials`): 0 unknown, 1 brick, 2 glass, 3 concrete (precast panels, cast concrete, block), 4 stone (ashlar, granite, limestone, marble), 5 metal (panel or standing seam), 6 stucco (plaster, render), 7 wood (clapboard). It is what the wall is made of whatever its kind says: a `generic` or `office` building of brick, a 1980s `office` tower of stone, a `glass` tower of glass. A building the data does not describe gets one inferred from its kind, style, era, height and neighbours.
- `style` is an architectural style id (`buildingStyles`): 0 unknown, 1 classical (Beaux-Arts, Neoclassical, Georgian), 2 victorian (Victorian, Romanesque, Gothic Revival and other traditional masonry: tall narrow windows, lintels and sills), 3 artdeco, 4 modernist (International style, mid-century: ribbon windows on offices, punched windows on housing), 5 brutalist, 6 postmodern (1980s and 90s stone towers with a base and a crown), 7 contemporary (large panels, full glass), 8 vernacular (houses, sheds, warehouses).
- `band` is `bandMaterial | (crown >> 1) << 3`: the low three bits are the material id of the ground floor band (a stone or dark concrete base under a curtain wall; equal to `material` when it is the same), the upper five bits are the height of the **crown** in steps of 2 m (0 to 30 m): the top of a tower where the windows stop (a lit crown, a mechanical screen). The windows therefore end `crown` metres below the wall's top, and the floor height is `(v1 - v0 - band / 10 - crown) / floors`.
- `flags` says where each part of the look came from, as a bit set: 1 wall colour from data, 2 material from data, 4 style from data, 8 floor count from data, 16 height known (from the list of known heights), 32 roof colour from data, 64 a curated entry (`building-appearance.json`), 128 era or material decided by the neighbours. A bit that is not set means the pipeline inferred it. (`_BID.y` bit 16 and 128 keep their meaning for era and kind.)
- On a roof, `roofMaterial` is 0 membrane (tar, gravel; a flat roof's default), 1 metal (standing seam), 2 tile (clay), 3 shingle (asphalt), 4 concrete, 5 green (planted), 6 copper (patina), 7 gold, 8 white (a cool roof); `material` is the wall's material (for the parapet and gable faces, which are in the roof mesh).
- **Colour.** `COLOR_0` of walls is the wall colour (linear RGB, lightness varied a little per building) and of roofs the roof colour: from data (`building:colour`, Overture `facade_color` and `roof_color`, the curated list) when it is believable (a placeholder blue or black is pulled toward a wall colour of the same hue and lightness, a white roof stays white), else the palette of the material (limestone, granite and pink granite, red and buff brick, precast cream, glass tints from blue-grey to bronze). The game's grade desaturates it; the data is the colour of the stuff, not of the picture.
- **Where the data comes from.** Per building, strongest first: the curated list (`data/cities/<city>/building-appearance.json`, each entry cited), an explicit OSM tag (`building:colour`, `building:material`, `building:architecture`, `roof:colour`, `roof:material`, `start_date`, `building:levels`, `building:min_level`, `roof:levels`, `height` in m or ft), Overture (`facade_color`, `facade_material`, `roof_color`, `roof_material`, `num_floors`, `height`), then Wikidata (year, architectural style, material and floors of the OSM building's `wikidata` item). Heights in `data/cities/<city>/building-heights.json` (Wikipedia's list of tallest buildings, made by `src/facts-import.ts`) are matched by position and fix a baked height that is a little short (a rounded value) or far too tall (a podium that took its tower's height); a known tower on a much bigger, lower footprint (a hotel's podium) is split from it as a square of about 40 m2 per floor. OSM `building:part` ways with no `building` tag become parts of the building they lie in when Overture has none for it. An OSM building's height and levels go to an Overture footprint only when the footprint is that building (areas within a ratio of 2.5), and to the smallest OSM building that holds its centre. Names (a building's, a brand's) steer the kind and nothing else: **no name, brand or sign is written to a tile**.
- **When the data says nothing** (about 90% of buildings in Atlanta's extracts: Overture has facade colour for 0.3% and material for 1%, OSM `building:colour` for 0.3%), the kind, era and material are inferred, in this order: the year (the era), the style, the neighbours (dated or materialled buildings within 90 m; a narrow low-rise that shares its walls is a pre-war commercial row), the height and the plan, then a draw seeded by the building's id. A tower of 55 m or more is a curtain-wall `glass` building unless its data says masonry, a date before 1968, a traditional style, a heritage listing, an old-building name ("... Building" rather than "... Tower"); a tower dated 1968 to 1989 with no material is a frame clad in precast or stone two times in five. A university building downtown is the 1960s to 80s concrete campus. A smokestack, silo or tank is a `small` building with no windows.
- **Height checks.** A car park taller than 45 m takes its height from its floors (3.2 m each); a footprint whose OSM building is much bigger than it takes none of its height or levels.

### `props.json`

Anchors for the trees, street lamps and street furniture of the next phases. **Not geometry**: the client instances models at these points. Optional: a tile without it has no anchors. Written by `tools/pipeline/src/world/props.ts` from OSM and synthetic placements only (no canopy raster: its licence is not settled). All coordinates are the tile's; `y` is the ground (or deck) height at the point. `yaw` is the way the object faces, as a ped's yaw: forward is `(sin yaw, cos yaw)` in `(x, z)`.

```jsonc
{ "version": 1,
  "trees":     [ [x, y, z, height, crownRadius, class, src], ... ],
  "lamps":     [ [x, y, z, yaw, poleHeight, kind, src], ... ],
  "hydrants":  [ [x, y, z], ... ],                    // OSM emergency=fire_hydrant
  "bins":      [ [x, y, z], ... ],                    // OSM amenity=waste_basket
  "bollards":  [ [x, y, z], ... ],                    // OSM barrier=bollard
  "stats": { "trees": { "osm": 0, "row": 0, "street": 0, "park": 0 }, "lamps": { "osm": 0, "synthetic": 0 }, "osm": true } }
```

- **Trees.** `class`: 0 broadleaf (oak, maple), 1 conifer (pine), 2 small ornamental (crape myrtle, pear). `height` and `crownRadius` are metres (from the OSM `height` and `diameter_crown` tags when present, else a seeded draw by class). `src`: 0 synthetic street tree (along a sidewalk, 10 to 16 m apart, thinned so a street is patchy), 1 OSM `natural=tree` node, 2 OSM `natural=tree_row` (placed every 8 m along the way), 3 synthetic park and woodland fill (jittered grid, 8 to 12 m in parks, 6 m in woodland). No tree stands in a footprint, on a road, or within 2.5 m of a lamp.
- **Lamps.** `kind`: 0 cobra-head arm lamp (the arm points along `yaw`, towards the road), 1 pedestrian post-top lamp (no arm), 2 tall highway mast. `src`: 0 OSM `highway=street_lamp`, 1 synthetic. Synthetic lamps stand 1.2 m behind the kerb line, every 32 m along primary, secondary and tertiary streets (staggered on the two sides, so one every 16 m along a street), every 40 m on residential streets, every 20 m on pedestrian streets and plazas (post-top), and every 48 m along motorways and trunk roads (masts, on a deck at the deck's height). None is within 8 m of a junction centre, in a footprint, or within 10 m of an OSM lamp. Lamps are for night lighting anchors: sodium-orange light pools and glow sprites are the client's job.
- **Furniture.** OSM only for now: hydrants, bins and bollards (`[x, y, z]`, no yaw: the models are round).
- **Colliders (sim) and models (client).** The sim reads the file too (`TileData.anchors`): the **lamp poles, tree trunks, hydrants, bins and bollards are solid**, as boxes from `src/shared/data/propDims.json` (the one file that also sizes the Blender models: `tools/blender/props/`), merged into one compound collider per 40 m cell. A lamp's pole is `r` thick (scaled by `poleHeight / refH`), solid to `solidH`; a tree's trunk is `r` thick (scaled by `crownRadius / refR`) and solid 3 m up. There is no collider for a crown or a lamp arm. The tree's species is a function of its place and class (`treeSpecies` in `src/shared/props.ts`), so both sides agree.
- **Clear of the cars' paths.** No tree, lamp, hydrant, bin or bollard stands within 1.6 m of a lane's or a junction curve's centreline (`lanes.json`): a corner lamp or a tree on the inside of a turn stood where the turning cars go, and an OSM bollard in a carriageway would stop the traffic. (`scenarios.json` leaves out the bus stops and benches in a car's path the same way.)
- The file is deterministic (seeded by position).

### Hero landmarks (`landmarks.json`)

A **hero landmark** is a hand-built model (a Blender script, `tools/blender/landmarks/`) that stands where a real building's generic extrusion would be: Mercedes-Benz Stadium, the Capitol, the Westin. The mechanism is the same for any city and **optional**: a city with no `data/cities/<city>/landmarks.json` or no models under `public/assets/landmarks/`, and a tile with no heroes, bake and draw exactly as before (no `landmarks` field in `tile.json`).

**Inputs of the bake** (`tools/pipeline/src/world/landmarks.ts`):

| File | What |
|---|---|
| `data/cities/<city>/landmarks.json` | The city pack: `{ landmarks: [ { id, name, displayName, kind, lat, lon, x, z, radius?, ... } ] }`. `name` is the real name, `displayName` what the game shows (a parody where the name is a brand). |
| `public/assets/landmarks/<id>.glb` | The model, built by `npm run assets` (`id` is the pack's id). |
| `public/assets/landmarks/<id>.json` | Its **sidecar**, written with it: `anchor { x, z, lat, lon }` (the model's origin: a game point at ground level; the pipeline places it at the projection of the lon/lat, so the same sidecar works for any tile origin), `yaw` (radians about +Y; 0 for the models of this repo, which are drawn in the world's axes so the footprint they show is the real one with its real orientation), `height`, `radius`, `lods [{ tris, from }]`, `hull [{ ring, height }]` (collision, model frame), `cutout` (the footprint it stands on, model frame), `replaces { overture: [uuid], osm: ["osm:way/1"], also: ["overture:<uuid>/1"], overlap }`, optionally `clear` (rings that no tree or lamp may stand in) and `datum` (`"min"`, the default, or `"max"`: which ground height under the footprint is the model's y = 0; a building stands on its low side, a flat plaza on its high side). |

**What the bake does.** A landmark with a sidecar is a hero. It
1. **suppresses the generic buildings it replaces**, before the roads cut them and before anything else sees them: a building goes when its id is in `replaces` (the Overture uuid, the full `overture:<uuid>/<i>` id or an OSM id) or when at least `overlap` (default 0.4) of its footprint lies inside the cut-out. They are in neither `buildings.glb` nor `collision.bin`;
2. **adds its hull** to the collision mesh: each prism of `hull` (the drawn silhouette of the lowest metres, a little inside it) is a building of the bake that is not drawn, so it is in the **first `collision.buildingTriangles` triangles** like any building (walls and a flat roof; the sim recovers the footprints from it), in the ambient-occlusion raster, and in the footprints the walk network, the props and the spawns keep clear of. A hull is **clipped to the tile's bounds**: nothing is solid past the heightmap (a stadium that overhangs the tile edge is solid only on the tile's side). Drawn and solid agree because the hull is part of the model's own script;
3. keeps trees and lamps out of its cut-out (and `clear` rings);
4. writes `landmarks.json` into the tile.

```jsonc
{ "version": 1,
  "landmarks": [ {
      "id": "westin-peachtree-plaza", "name": "Westin Peachtree Plaza", "displayName": "Peachtree Summit Plaza", "kind": "tower",
      "x": 132.4, "z": -570.0,                 // game position (a hero: the model's anchor)
      "radius": 60,                            // "at the landmark": within this many metres of (x, z) ...
      "ring": [[x, z], ...],                   // ... or, for a hero, inside this footprint grown by 14 m (shared/landmarks.ts RING_MARGIN_M)
      "hero": { "model": "assets/landmarks/westin-peachtree-plaza.glb", "hash": "abc123def456",
                "y": 3.2,                      // ground height under the model: the model's y = 0 (the bake's datum, as for a building)
                "yaw": 0, "lods": [ { "tris": 876, "from": 0 }, { "tris": 348, "from": 700 } ],
                "replaced": [ "overture:16cab934-..." ], "hullTris": 108 }   // the generic buildings it replaced; hull triangles in collision.bin
  } ] }
```

Every landmark of the pack that is in the tile (or whose model reaches into it) is listed, heroes or not: the file is also where the client reads **names** from (`src/shared/landmarks.ts`: `landmarkAt` says which landmark a point is at; the street-name label shows its `displayName` as the area line: "Peachtree St NW" over "Peachtree Summit Plaza").

**Moving parts.** A model may have nodes `lod<N>_<name>` (an empty at the pivot, the meshes under it relative to the pivot) whose glTF extras say how the game moves them (`Landmarks.ts`, "Animated parts"): `{"anim": "spin", "axis": [x, y, z], "period": s}` turns the node about its own origin (the observation wheel), and `{"anim": "gondolas", "hub": [x, y, z], "axis": [...], "count": n, "period": s}` draws the meshes under it `n` times, riding a circle about `hub` without turning, so the wheel's cabins hang level. They run only while their level is shown and the camera is within 700 m, and cost a few matrices a frame (no allocation). The fountain's jets are the `lm_water` material: the vertex shader raises and bends them by a wave round each ring (`COLOR_0`: r the height along the jet, g the place round the ring, b the bearing it leans to) and one uniform is all the CPU does.

**The model** (`<id>.glb`, glTF binary, meshopt-compressed, float attributes for the facade data): groups `lod0`, `lod1` ... (each with one mesh per material, `lod<N>_<material>`), one visible at a time by the camera's distance (`from`, metres, before the tier's `lodScale`); a big LOD0 is 2k to 40k triangles, the far one a few hundred. Materials, by name, are the game's: `bld_wall` and `bld_glass` carry `TEXCOORD_0`, `_WALL`, `_BLD`, `_BID` exactly as the tile's walls do (see "Mesh attributes"), so the look's window shader lights and dirties them; `bld_roof`; and `lm_stone`, `lm_flood` (floodlit at night), `lm_lit` (lit from within), `lm_metal`, `lm_gold`, `lm_glass`, `lm_glow` (emissive at night), `lm_dark`, `lm_water` (animated jets: `COLOR_0` is data, not albedo). `COLOR_0` is the albedo and its alpha the baked occlusion. No texture, no brand mark or lettering. The client places each model at `(x, hero.y, z)` turned by `yaw` and loads `?v=<hash>` from `src/client/render/landmarkAssets.manifest.json` (the hash of the file, so a rebuilt model is not served from the year-long cache). A model that fails to load leaves a hole where its building was; the game goes on. **A hero that spans tiles** (Mercedes-Benz Stadium stands 24 m past the west edge of this one) is listed by every tile it touches, each tile with its own clipped hull, and the client draws it once per id; a hero whose footprint lies wholly past a tile's edge is not in that tile's file (it would hang in the void there); its generic building is suppressed only in the tiles whose footprints it replaces (a building whose centre is past a tile's edge is not in that tile anyway).

**Airport heroes** (`public/assets/airport/<id>.json`, built by `tools/blender/airport/`, read by the bake when the tile's grid
has an airport; city-tiles.md section 16). Their sidecars add:

| Field | What |
|---|---|
| `elevation` | metres above sea level of the model's y = 0. The datum is then this (`elevation - baseElevation`), the same in every tile, instead of the lowest ground; the Domestic Terminal and Concourse T share one, as do Concourse F and the international terminal |
| `flatten` | `[{ ring, margin }]`, model frame: the bake sets the ground inside each ring to the datum and blends back over `margin` m, before the roads are designed |
| `interior` | a walk-in hero (the Domestic Terminal, Concourse T), model frame, y above the floor: `walk { nodes [[x, y, z]], edges [[a, b, width]], doors [node] }` (merged into `paths.json`, cut at the tile's edges; a door is joined by a `link` edge to the nearest node of another network within 30 m in a clear line), `scenarios [{type, x, y, z, yaw, cap}]` (into `scenarios.json`; type `seat` sits on a seat the model draws: no bench is drawn or made solid), `places [{name, x, z, r}]` (into `landmarks.json` as entries of `kind: "place"`, which the street label prefers inside their radius), `zones [{ring, ceiling}]` (on the hero's entry as world rings) |
| `hooks` | `transitStation { x, z, yaw, length, width, floorY }`: the room the Domestic Terminal leaves open at its west end for the MARTA platform (the rail layer builds it) |

A walk-in hero's hull is its walls, counters, carousels and posts as thin prisms: none is dropped for being small (0.2 m² and up),
its cut-out takes every generic building that reaches into it (3% of the building's footprint), and an airport hero's hull is cut by
the lanes like any building (a vestibule or a canopy column a curb lane runs through). Models use the interior materials
`lm_interior` (lit from within), `lm_floor`, `lm_window` (see-through, both sides) and `lm_screen` (unlit, emissive).

**The airfield** (roads.glb, a tile of a grid with an airport): nodes of kind `airfield` (material `road_airfield`: runways,
taxiways, aprons and the runways' asphalt shoulders, one non-overlapping set of polygons per tile, 3-6 cm over the ground; over a cut
a deck with an underside in `road_concrete` and its slab in `collision.bin` after the buildings) and `aeromarkings` (material
`road_aeromark`, white and yellow vertex colours, 3.5 cm over the pavement; never hidden by distance). The client gives
`road_airfield` a weaker polygon offset than the roads (they win where a road crosses an apron) and `road_aeromark` one between.

## Rules

- The sim worker reads `tile.json`, `height.bin` and `collision.bin`, and `roads.json` when `tile.json` names one (optional: without it no cars are parked at the curb). It also reads `junctions.json`, `paths.json` and `scenarios.json` when named (optional: without `paths.json` there are no ambient pedestrians). It never parses glTF and never imports three.js. `props.json` is read by both: the client draws it (trees, lamps, furniture), the sim makes the poles and trunks solid (`loadBakedTile` reads it into `TileData.anchors` with `parseProps`).
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
- **Signals**: phases are not baked. `phaseOf(junction, t)` in `src/shared/signals.ts` gives the lamp of each approach group, as a pure function of the junction record and the time, so the sim, the client and pedestrians agree without snapshot bandwidth. `heads` say where the poles stand: on the kerb to the right of the approach lanes, 1.5 m past the stop bar, moved further out (up to 3 m) until the pole is 1.8 m clear of every lane's and junction curve's centreline (a right turn sweeps round the corner just past the bar).
- **Connectivity**: `npm run verify` reports the share of lane length in the largest strongly connected component. A freeway that runs off the clipped tile cannot loop back, so the check judges surface streets (at least 70%). The sim routes and spawns cars on edges of the largest component and on the *through routes*: the lanes on a path from where traffic enters the loaded area (a lane that starts at its edge, with nothing leading into it) or from the main component, to where it leaves it (a lane that ends at its edge, with nothing after it) or to the main component. A freeway does not loop inside a tile, but it is a through route, and cars enter at its sources and are removed at its sinks. A lane that stops at a seam to a loaded neighbour is neither (the edge of the loaded area is told from the tiles' rectangles, 30 m past the lane's end). See `docs/contracts/population-data.md`.


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
- **No walking on a freeway.** The walk geometry that lies on a motorway or trunk carriageway (or a ramp's, 1.2 m inside it) at the carriageway's own level is cut away (`stats.droppedByFreewayM`), and so is anything a link pass would have drawn across one. A way that touches a freeway and has a bridge (a street's, not a freeway's) over it has its stretch under that deck put on the deck (`stats.liftedToDeckM`: the mapped sidewalks of a bridge carry the ground's height otherwise, which is the cutting's floor). Crossings over the mouth of a ramp stay. Pieces the cut left apart are joined again where nothing is in the way, so the largest component stays at 97% or more. The sim closes the same edges again at load (`src/sim/peds/freeway.ts`) for a tile baked before this.
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

- `type`: `bench` (sit; the client draws a bench there), `busstop` (wait; the client draws a stop), `atm` (one person at the machine, facing the building), `shopfront` (browse a window; a pair chats), `eatery` (wait or chat at a restaurant, cafe or bar), `lawn` (sit or chat in a park, away from the paths), `plaza` (chat, or photograph), `corner` (wait at the kerb of a signalised crossing, on the phone or chatting), `seat` (sit on a seat a model draws: an airport holdroom's; nothing is drawn or made solid for it).
- `yaw` is the way people face, as a ped's yaw: forward is `(sin yaw, cos yaw)` in `(x, z)`. `cap` is how many people use it at once. `src` is `osm` (from the map) or `synth`.
- Points on a sidewalk are on the walk network (snapped to it), clear of footprints by 0.4 m. POIs inside a building are moved out to the nearest sidewalk and face the building.


### `transit.json` (the transit layer)

The city's rail transit, in files of its own so the roads are untouched: `transit.json` (data), `transit.glb` (meshes) and
`transit.bin` (collision). Written by `tools/pipeline/src/world/transit*.ts`, as a step of `npm run bake` or alone over a baked
tile with `npm run transit` (both under `flock /tmp/hood-bake.lock`). Optional: a tile without `transit` in `tile.json` has no
trains, and a city without `data/cities/<city>/transit.json` bakes none.

**Inputs.** One Overpass query over the city pack's `box` (the whole network: route relations with their ordered members,
every `railway=subway` way with its geometry, tunnels and bridges included, platforms, stations, stop positions and entrances),
cached once per city under `tools/pipeline/cache/<city>/transit/` and fetched with the grid prefetch's polite client (one request,
backoff with jitter, validated before it is cached). The pack (`data/cities/<city>/transit.json`) adds what OSM does not say: the
brand the game shows (a parody; the real agency's name and marks never appear), the lines' colours and the route relations they
run on (one per direction), the stations' depths below the street by OSM layer (Peachtree Center 37 m, Five Points 10 and 18 m:
see its comment for the sources), in-game names for stations whose real names are brands (SEC District is Stadium District),
and the synthetic timetable. No GTFS data is used (its terms are in `docs/tools-wishlist.md`).

**What the bake does.**
1. Each route relation is chained into one run of nodes and cut to the tile plus 420 m (the design needs the track beyond the edge).
2. **Stations** are the OSM station nodes in the tile; their platforms (OSM, `subway=yes`, within 190 m) grouped into **levels**
   by layer, each with a frame along its tracks (the platforms' principal axis), a platform at least 152 m long (a six-car train is
   141.7 m) and a height: an underground platform's top is the street level (the highest ground at the node and its entrances)
   less the pack's depth, and never closer than a concourse and a slab under the lowest ground over the concourse and the way to
   its entrances; an elevated one stands the pack's height over the middle of the ground under it and 6.4 m plus the platform
   over any road under it. Levels under each other are kept a slab apart.
3. **The tracks' heights** are designed on the union of the routes' ways, densified to 6 m: held level at each platform (rail =
   platform top - 1.1 m) through the hall and 18 m past it, pulled toward a target for what OSM says each way is (a tunnel 12 m
   down, a trench 6 m down, a viaduct over the roads it crosses, the ground), inside its bounds (bounds give way over 260 m round a
   change of structure: the portal ramps), smoothed, and at most 4% steep (every vertex inside the band the held vertices allow,
   then relaxed). The structure is then read back from the design: a **tunnel** where the rail is 6.3 m or more under the ground
   (a roofed box), an open **trench** where it is under the ground but not that deep, the **ground**, or a **viaduct**.
4. An island the map draws too narrow (the two tracks drawn close) is widened to 9 m: its two tracks part through the station,
   eased back over 90 m either side.
5. **Station layout** (all boxes, slabs and ramps in a level's frame): the hall round the tracks and platforms (walls 2.4 m past a
   track, 4.5 m to the ceiling, tunnel mouths in the end walls); for an underground station a concourse (pack size, grown to hold
   the shafts) with a paid area inside it ringed by railings and two banks of four fare gates (0.86 m gaps between 0.26 m
   cabinets 0.85 m tall: a player can just jump one), a shaft of stairs and two escalators down to each level (30 degrees, clear of
   the other halls, a 2.2 m walk either side of it on the island); for each OSM entrance a stairwell from the street (placed clear
   of buildings, carriageways, poles, trees and other wells, along the most natural way down) and a corridor to the concourse. An
   elevated platform gets a stair down to the street with three gates across its foot (a side platform's from a landing beside
   it). Elevated stations' own structures, which the map draws as buildings round the platforms, are left out of the tile's
   buildings (the bake's `transitCutouts`: generic buildings 30% or more inside an elevated platform's outline grown 4 m along and
   8 m across).

```jsonc
{ "format": "hood-transit", "version": 1,
  "brand": "Peach Rapid Transit", "brandShort": "PRT", "agency": "tap",          // the agency (jurisdictions.json) of the stations
  "lines": [ { "id": "red", "ref": "Red", "name": "Red Line", "colour": "#d4202c" } ],
  "routes": [ {                                                                   // one line, one direction, cut at the tile's edge
      "id": "red-0", "line": 0, "osm": 304619, "towards": "Airport",               // the whole line's terminus
      "pts": [x, y, z, ...], "cum": [0, 2.9, ...], "len": 2336.2,                  // rail top, about 3 m apart; cumulative distance
      "stops": [ { "station": 1, "platform": 0, "s": 492.4, "side": 1 } ],        // s: where the HEAD stops; side +1: platform on the left
      "enter": "n", "exit": "s",                                                   // the tile side it comes in and goes out at (null: starts/ends inside)
      "speed": [[0, 15.5], [120.3, 12], ...],                                      // limit (m/s) from s on: OSM maxspeed, 0.9 m/s2 on curves
      "reverse": 1 } ],                                                            // the same line's other direction
  "tracks": [ { "id": 0, "osm": 0, "pts": [x, y, z, ...], "runs": [[0, "tunnel"], [57, "station"], ...] } ],   // physical tracks, for drawing
  "stations": [ {
      "id": "five-points", "name": "Five Points", "displayName": "Five Points", "osm": 318451223,
      "x": -166.2, "y": 5.2, "z": 45.3, "underground": true, "lines": [0, 1, 2, 3],   // y: street level
      "platforms": [ { "kind": "island", "y": -7.3, "c": [x, z], "axis": [ax, az], "halfLen": 76, "halfWidth": 4.5, "layer": -1,
                       "routes": [4, 5, 6, 7], "waits": [[x, y, z, yaw], ...] } ],  // waits: where people wait (the layer's scenario points)
      "concourse": { "c": [x, yFloor, z], "axis": [ax, az], "halfLen": 34, "halfWidth": 26 },  "paid": { ... },   // null for elevated stations
      "entrances": [ { "x": .., "y": .., "z": .., "yaw": 2.54, "foot": [x, y, z], "osm": 7489920943 } ],      // top of the stairs at the street, the way down
      "gates": [[x, z, nx, nz], ...] } ],                                           // each gate gap's middle and the unit normal INTO the paid area
  "volumes": [ { "c": [x, y, z], "h": [hx, hy, hz], "yaw": 0.97, "kind": "interior" | "open", "station": 0 } ],   // the spaces under the ground
  "holes": [[x, z, hx, hz, yaw], ...],                                              // stairwells: where the ground and street meshes are not drawn
  "anchors": [ { "kind": "column", "x": .., "y": .., "z": .., "yaw": .., "station": 0, "platform": 0 } ],        // station kit instances
  "walk": { "nodes": [[x, y, z], ...], "edges": [a, b, kind, ...] },                // kinds: 0 floor, 1 stairs, 2 fare gate, 4 street link
  "timetable": { "secondsPerMinute": 20, "headways": [{ "from": "06:30", "to": "09:30", "minutes": 6 }, ...], "dwellS": 22, "transferDwellS": 30,
                 "cars": 6, "accel": 1.0, "brake": 1.1, "maxSpeed": 31.3 },
  "collision": { "file": "transit.bin", "vertexCount": 31140, "indexCount": 46884 },
  "mesh": "transit.glb",
  "stats": { ... } }                                                                // what the bake found (stations, profile, metres by structure)
```

- **Coordinates** are the tile's; every `y` is a height in the tile's frame. A box's `yaw` turns its local +Z to `(sin yaw, cos yaw)`
  in (x, z) (as a ped's yaw); its local +X is `(cos yaw, -sin yaw)`. Platform `axis` is the unit direction of the tracks.
- **Volumes** are the spaces under the ground (halls, concourses, corridors, stairwells and shafts in 3 m pieces, tunnels and
  trenches in pieces of track): inside one, a person's character controller meets only the transit layer (`GROUPS.undergroundQuery`),
  not the ground or the buildings over them; `interior` ones are out of the sun (the client's light), `open` ones (trenches) are not.
- **Kit anchors** (`kind`): `column`, `bench`, `sign_name` (the station's name), `screen` (next trains, `platform`), `lamp_tube`,
  `fare_gate` (a cabinet: two per gap), `railing` (1 m sections), `canopy` and `pylon` (entrances), `map_board`, `bin`, `tunnel_bay`
  (tunnel wall details, lamps every 12 m). The models are `public/assets/transit/station-kit.glb` (tools/blender/transit/kit.py).
- **`transit.glb`**: one node per 256 m chunk and material, `transit_int_<cx>_<cz>` (material `tr_int`: under the ground; `COLOR_0`
  rgb is the albedo and **alpha the light baked from the station's lamps and the tunnels' lights**, not occlusion: the client draws it
  unlit by the sun) and `transit_ext_<cx>_<cz>` (`tr_ext`: viaducts, piers, open stairs; alpha 1). Tunnels are a box round a track
  (5.0 m over the rail, 2.6 m either side), one box round two tracks within 9 m of each other; viaducts a girder with parapets
  and piers clear of carriageways; rails, plinths and a third rail with its cover board everywhere.
- **`transit.bin`**: like `collision.bin` (float32 positions, then uint32 indices): halls, platforms and their edges, concourses,
  corridors, shafts and stairs (a stair is a smooth ramp through its nosings), tunnel tubes, trench walls, viaducts, parapets and
  piers, and boxes for the columns, benches, gate cabinets, railings, bins and pylons. The sim builds it as one fixed trimesh in
  `Group.Transit` (solid to everything).
- **Trains** are the sim's (`src/sim/transit`): the file only gives routes, stops and the timetable. The headway is the
  timetable's minutes for the game clock's time of day times `secondsPerMinute` sim seconds (the game clock runs 30 times real
  time; real minutes would leave a platform empty for game hours), the lines of a shared track taking turns.
- **Checked** by `tools/pipeline` `npm test` (test/transit.test.ts) and `npm run verify` (grades at most 4%, every station
  reachable on its walk network from each entrance, every stop on its platform, collision present), and in the sim by
  tests/transit/*.test.ts (a walker gets from every entrance to every underground platform on the real tile).
- **For the M2 grid** (docs/contracts/city-tiles.md): the query is city-wide already and each tile cuts the network to its cell;
  what a streamed city still needs is in that file, section 15.
