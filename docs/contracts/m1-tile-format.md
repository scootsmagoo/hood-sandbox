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
    "vertexCount": 0, "indexCount": 0
  },
  "roads": "roads.json",                     // centrelines for later traffic and minimap work
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
               "width": 14.0, "points": [[x, y, z], ...] } ] }
```

### Spawns

- `player`: `y` is the surface height at that spot (sidewalk top), so the client may drop the capsule a little above it. The player starts on foot here.
- `vehicle`: `y` is the road surface height. `heading` is the three.js `rotation.y` of an object that faces −Z at 0, so the forward vector is `(−sin h, −cos h)` in (x, z). Positive turns toward west.
- The two are meant to be a few metres apart: the vehicle parked at the right-hand curb of a street, the player on the nearest sidewalk. The sim puts a stand-in driver in that car (the player carjacks it), and parks more empty cars along nearby curbs using `roads.json`.

### Mesh details (client-facing)

- The `.glb` files use `EXT_meshopt_compression` and `KHR_mesh_quantization` (16-bit positions). Positions are quantized per mesh, so each mesh node carries a scale and translation. three's `GLTFLoader` needs `setMeshoptDecoder(MeshoptDecoder)`.
- All meshes carry `COLOR_0` (RGBA, normalized uint8, linear). Materials are white, so use `vertexColors: true`. Materials per file: `ground`; `road_asphalt`, `road_sidewalk`, `road_crosswalk`, `road_rail`, `road_concrete` (deck undersides, skirts, piers); `bld_wall`, `bld_roof`, `bld_glass` (towers of 55 m and up, metallic).
- `ground.glb` is the heightmap at full resolution (`groundMeshStep` in `city.json`), triangulated with the diagonal from the south-west to the north-east corner of each cell, split into chunks with two levels of detail (see "Chunks"). Sampling the heightmap bilinearly differs from the level 0 mesh by a few centimetres at most.
- At-grade road meshes sit 4–14 cm above the ground mesh (sidewalks 10 cm, crosswalks 14 cm, motorways 10 cm, residential streets 6 cm), so the sim can treat the heightmap as the road surface. Add `polygonOffset` to the road materials to hide depth fighting at distance.
- Tunnels (`tunnel=*`, negative `layer`) are not in the tile.

### Chunks

Each `.glb` holds one node (with one mesh and one primitive) per chunk and material, so the renderer can frustum-cull them: a view draws a few dozen chunks instead of the whole tile. The chunks are the squares of a grid over `bounds`: chunk `(cx, cz)` covers `x` from `minX + cx * size` and `z` from `minZ + cz * size`, `size` metres each (256 m by default, `chunkSizeM` in `city.json`; the last row and column are cut short by the bounds). `tile.json.chunks` describes the grid, and every node says which chunk it belongs to in its glTF `extras` (three.js puts them in `userData`):

```jsonc
{ "kind": "ground" | "asphalt" | "sidewalk" | "crosswalk" | "rail" | "concrete" | "walls" | "roofs" | "glass_walls",
  "chunk": [cx, cz],
  "lod": 0 }                  // ground only
```

Node names are `<kind>_<cx>_<cz>` (ground: `ground_<cx>_<cz>_L<lod>`). A chunk with nothing of a material has no node for it.

- **Roads and buildings**: a triangle belongs to the chunk that holds its centroid, and is never cut, so a chunk's geometry can reach a few metres past its square. Use each mesh's own bounding sphere for culling (three.js computes it from the geometry), never the chunk square.
- **Ground levels of detail**: every chunk has two ground nodes, both covering the chunk's square. Level 0 is the full-resolution ground (`groundMeshStep`). Level 1 is every 4th sample of it (`step` in `groundLevels` counts heightmap cells): it is for far chunks. Show exactly one of the two per chunk. The client switches to level 1 when the camera is more than 400 m (times the tier's `lodScale`) from the chunk's square, with a little hysteresis. Level 1 differs from level 0 in two ways, so it never hides the roads that lie on the ground or shows cracks against a level 0 neighbour: its interior vertices are `lower` metres (0.5) below the terrain (the vertices on the chunk's border are not), and it has a vertical `skirt` of 3 m round its border (double-sided).
- Chunk edges are seamless within a level: normals come from the whole heightmap, and border vertices sit at the same positions in neighbouring chunks.
- A tile without `chunks` (an older bake) is one node per material; the client treats every node as a plain mesh.

### `collision.bin` contents

Building walls and roofs (footprints simplified to 0.4 m), plus elevated road decks (closed 1 m slabs, including footbridges) and bridge piers. At-grade roads are not in it; they are the heightmap.

### `roads.json` notes

`bridge` is true for any way on a deck (`bridge=*` or `layer` of 1 or more); `layer` is then at least 1. `y` on bridge points is the deck surface. Points are simplified (0.25 m tolerance in 3D) and ordered along the direction of travel for one-way roads. Only drivable classes are listed (no footways or rail).

## Rules

- The sim worker reads `tile.json`, `height.bin` and `collision.bin`, and `roads.json` when `tile.json` names one (optional: without it no cars are parked at the curb). It never parses glTF and never imports three.js.
- The client renders the `.glb` meshes and may also show the heightmap.
- Until a baked tile exists, the client falls back to a procedural test ground that has the same shape (a flat heightmap, some boxes, a spawn laid out like the real one, and a few street centrelines in `roads`).
- Baked tiles are build output. `public/tiles/` is gitignored and regenerated with `npm run bake` in `tools/pipeline/`.
