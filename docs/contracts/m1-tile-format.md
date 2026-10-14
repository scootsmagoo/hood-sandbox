# M1 tile format (contract between the pipeline and the client)

The world pipeline (`tools/pipeline/`) writes a baked tile. The client (`src/`) and the sim worker read it. Either side may propose a change, but the change goes into this file before the code changes.

M1 bakes one tile at **real 1:1 scale** (the compression warp arrives in M3).

## Coordinates

- 1 unit = 1 metre.
- **+X = east, +Y = up, +Z = south** (north is −Z), the three.js convention.
- Projection: `+proj=tmerc +lat_0=33.85 +lon_0=-84.3 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m` gives easting E and northing N.
- The tile origin is **Five Points (33.7539 N, 84.3916 W)**, projected to `(E0, N0)`. Game `x = E − E0`, `z = −(N − N0)`.
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
  "origin": { "lat": 33.7539, "lon": -84.3916, "E": -8486.774, "N": -10655.529 },   // E0, N0: the origin projected
  "baseElevation": 300.0,                    // metres above sea level at the origin
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

- `player`: `y` is the surface height at that spot (sidewalk top), so the client may drop the capsule a little above it.
- `vehicle`: `y` is the road surface height. `heading` is the three.js `rotation.y` of an object that faces −Z at 0, so the forward vector is `(−sin h, −cos h)` in (x, z). Positive turns toward west.

### Mesh details (client-facing)

- The `.glb` files use `EXT_meshopt_compression` and `KHR_mesh_quantization` (16-bit positions). Positions are quantized per mesh, so each mesh node carries a scale and translation. three's `GLTFLoader` needs `setMeshoptDecoder(MeshoptDecoder)`.
- All meshes carry `COLOR_0` (RGBA, normalized uint8, linear). Materials are white, so use `vertexColors: true`. Materials per file: `ground`; `road_asphalt`, `road_sidewalk`, `road_crosswalk`, `road_rail`, `road_concrete` (deck undersides, skirts, piers); `bld_wall`, `bld_roof`, `bld_glass` (towers of 55 m and up, metallic).
- `ground.glb` is the heightmap at full resolution (`groundMeshStep` in `city.json`), triangulated with the diagonal from the south-west to the north-east corner of each cell. Sampling the heightmap bilinearly differs from the mesh by a few centimetres at most.
- At-grade road meshes sit 4–14 cm above the ground mesh (sidewalks 10 cm, crosswalks 14 cm, motorways 10 cm, residential streets 6 cm), so the sim can treat the heightmap as the road surface. Add `polygonOffset` to the road materials to hide depth fighting at distance.
- Tunnels (`tunnel=*`, negative `layer`) are not in the tile.

### `collision.bin` contents

Building walls and roofs (footprints simplified to 0.4 m), plus elevated road decks (closed 1 m slabs, including footbridges) and bridge piers. At-grade roads are not in it; they are the heightmap.

### `roads.json` notes

`bridge` is true for any way on a deck (`bridge=*` or `layer` of 1 or more); `layer` is then at least 1. `y` on bridge points is the deck surface. Points are simplified (0.25 m tolerance in 3D) and ordered along the direction of travel for one-way roads. Only drivable classes are listed (no footways or rail).

## Rules

- The sim worker reads only `tile.json`, `height.bin` and `collision.bin`. It never parses glTF and never imports three.js.
- The client renders the `.glb` meshes and may also show the heightmap.
- Until a baked tile exists, the client falls back to a procedural test ground that has the same shape (a flat heightmap, some boxes, a spawn).
- Baked tiles are build output. `public/tiles/` is gitignored and regenerated with `npm run bake` in `tools/pipeline/`.
