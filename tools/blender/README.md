# tools/blender: scripted Blender assets

Every model the game loads from here is built by a Python script, headless, from numbers in the
repo. Nobody opens Blender to make or change one: edit the script, run `npm run assets`, look at
the previews and the screenshots, commit the script **and** the `.glb` it wrote (outputs are small,
about 200 KB a car, and source-controlled, unlike the map tiles).

```
npm run assets                                  # build every asset, compress, then check them (tests/carAssets.test.ts)
node tools/blender/build.mjs --only sedan       # just one
node tools/blender/build.mjs --preview /tmp/p   # also render Cycles previews (front, rear, side, top, close, lod1, lod2)
node scripts/car-shots.mjs                      # in-game screenshots into .shots/cars-*.png (needs `npm run dev`)
```

Blender: `$BLENDER`, else `/snap/blender/current/blender` (the real binary; the `/snap/bin/blender`
wrapper fails in a non-interactive shell), else `blender` on the PATH. Tested with 5.2.2 LTS.
One asset by hand:

```
/snap/blender/current/blender --background --factory-startup --python tools/blender/build_asset.py -- \
    --module cars.sedan --asset sedan --out /tmp/sedan.glb [--preview /tmp/sedan] [--blend /tmp/sedan.blend]
```

`--blend` saves the built scene, if you do want to look at it in Blender. Note the scene is
modelled in the game's frame through `hoodlib.frame` (see below), so it opens the right way up.

## Layout

| Path | What |
|---|---|
| `assets.json` | The list `npm run assets` builds: name, Python module, the `handling.json` type it is built to, police or not. |
| `build.mjs` | Node driver: runs Blender per asset (4 at a time), compresses with glTF-Transform (meshopt, quantised), writes `public/assets/vehicles/<name>.glb` and `src/client/render/carAssets.manifest.json` (hash, size, triangles). |
| `build_asset.py` | Blender entry point: imports the module, calls `build(asset)`, exports. Prints `ASSET_REPORT {json}`. |
| `verify.ts` | The checks, used by `tests/carAssets.test.ts`: structure, triangle budgets, material names, bounds against the physics hull, wheel size and anchors, seat and door anchors against `src/shared/doors.ts`, file size. |
| `hoodlib/` | The shared library (below). |
| `cars/builder.py` | The parametric car: one function builds any car at any level of detail from a spec. |
| `cars/sedan.py`, `coupe.py`, `pickup.py` | Specs: profile curves and feature positions, read against the type's physics numbers. |
| `cars/police.py` | The police kit (lightbar, push bar, spotlight, livery band, steel wheels) on the sedan and coupe. |

### hoodlib

| Module | Use |
|---|---|
| `frame` | `to_bl(x, y, z)`: a **game** point (+X left, +Y up, +Z forward, the sim's frame) to Blender's Z-up frame. The glTF exporter's +Y-up conversion turns it back, so what a script writes as (x, y, z) is (x, y, z) in three.js. Always build through this (the `Mesh` builder does). |
| `curves` | `Profile([(z, y), ...])`: a monotone cubic through control points (no overshoot): side views, roof lines, plan widths. `stations()`: loft positions with dense spans and exact feature stations. `round_corner()`: plan-view corner radii. |
| `materials` | The slots by name: `paint`, `livery`, `trim`, `chrome`, `glass`, `interior`, `tyre`, `light_head`, `light_tail`, `light_reverse`, `light_bar_a`, `light_bar_b`. Every object gets all of them in this order, so face material indices mean the same everywhere (booleans keep their cutter's materials). The game swaps each for its own material by name. |
| `mesh` | `Mesh`, a bmesh builder in game coordinates: `loft` (rings of section points, optional caps), `sweep` (a 2D profile along a path: bumpers, lamp strips, tubes, flares), `lathe` (tyres, rims), `box` (bevelled), `cylinder`, `inset` (window frames), `split_off` (a door or bonnet cut out of the body), `thicken` (a back on a cut-out panel), `smooth` (sharp edges by angle and material). `to_object` triangulates, puts the elements in a canonical order (byte-identical rebuilds) and can set a pivot. `boolean` (exact solver) and `bake_modifiers` work without operators, headless. |
| `uv` | Box-projection UVs, 8 m to one UV unit, centred on 0.5 (they fit [0, 1] and quantise). |
| `lod` | `tri_count`, `tree_tris` (the one wheel counted four times), `decimate` (collapse to a target; not used by the cars, see "Levels of detail"). |
| `scene` | `reset()` (empties the factory scene), `empty()` (groups and anchors, with glTF extras). |
| `export` | `glb(path)`: the export settings (Y up, transforms applied, extras on, no animation, no vertex colours). |
| `handling` | Reads `src/shared/data/handling.json` (entries other than `sedan` inherit from it, as in `handling.ts`) into a `Car`: hull, wheel positions, the rest suspension length (as `RaycastCar.restHeight`), the road height, and `doors()`, a port of `doorGeometry()`. |
| `preview` | Cycles (CPU) quick-look renders of a built scene. |

## What a vehicle asset contains

The game reads these by name (`src/client/render/carAssets.ts`); `verify.ts` checks them.

```
car                          root; extras: asset, type, lod_tris
  lod0 / lod1 / lod2         one group per level of detail
    lodN_body                the shell: paint, trim, chrome, glass, interior (seats, dash, wheel), tyre-black wells
    lodN_door                the driver's door (left, +X), origin on the hinge (LOD0 and LOD1)
    lodN_hood                the bonnet, origin on its rear hinge (LOD0 and LOD1)
    lodN_bumper_F/_R         the bumpers, separate so they sag and fall off (LOD0 and LOD1)
    lodN_light_head/_tail/_reverse   the lamps, one object per kind (LOD2 has no reverse lamps)
    lodN_wheel               ONE wheel, the front left, origin on the hub; the game draws it four times,
                             the right-hand ones turned half round about Y
    lodN_police, lodN_light_bar_a/_b   police only: the kit, and the lightbar's halves (left, right)
  anchors
    anchor_seat, anchor_door, anchor_stand        = doorGeometry() of src/shared/doors.ts
    anchor_hinge_door, anchor_hinge_hood          pivots
    anchor_wheel_FL/FR/RL/RR                      the hubs at rest, where the sim puts them
    anchor_engine, anchor_bumper_F/_R, anchor_ground
```

Budgets (the wheel counted four times): LOD0 6–9k triangles, LOD1 about 2k (≤ 2.2k), LOD2 about 500
(≤ 600). The build reports them and warns when one is out; the test fails it.

Bounds: the body below the belt is within 6–8 cm of the hull's half-width, its ends within a few
cm of the hull's (bumpers may stand 12 cm proud), the roof within 12 cm under to 5 cm over the
cabin hull's top, and the tyre bottom on the road at rest. Wheels: radius and width from
`handling.json`, centred on the front-left hub.

## Adding a vehicle

1. **Physics first.** Give it an entry in `src/shared/data/handling.json` (or reuse one). The hull
   (`chassis`), wheel positions and suspension are what the model is built to.
2. **A spec.** Copy `cars/sedan.py` to `cars/<name>.py` (it is commented). The spec is all in the
   body frame, metres:
   - `z_front`, `z_rear`, `half_width`, `corner_front/rear` (plan view), optional `bulge` (haunches);
   - `y_bottom` and `y_top` as `(z, y)` points: the underside, and the line over the bonnet, along
     the belt and over the boot;
   - `greenhouse`: windscreen base, roof front and rear, rear window base, where the side glass
     ends (`c_z`), an optional black `b_pillar`, the roof line `top`, tumblehome and inset;
   - `doors` as `(rear z, front z)`, the driver's door first (it is cut out and hinged at its front
     edge); `seams` (panel gaps); `hood_z` (the bonnet's rear edge);
   - lamps (`head`, `tail` with an optional `reverse` share), `grille`, `bumper_front/rear`,
     `mirror`, `plate_rear`, `exhaust`, `moulding`, `wheel` style (rim size, spokes, slots,
     lugs, which slots its faces use);
   - `cuts` (boxes cut by booleans: a pickup's bed), `extra_parts` (functions that add meshes:
     flares, a spoiler), `extra_stations` (loft stations where a cut needs edges).
   `def build(asset)` loads the handling and calls `cars.builder.assemble(asset, spec, car)`.
3. **List it** in `assets.json` (and, if the sim spawns a new type, check `assetFor` in
   `src/client/render/carLod.ts`: a type falls back to its own name, then to the sedan).
4. **Build and look.** `node tools/blender/build.mjs --only <name> --preview /tmp/p`, then read
   the PNGs. Fix the spec, rebuild. Then `npm run assets` (all, plus the checks) and
   `node scripts/car-shots.mjs --only close` with `npm run dev` running, and look at it in the game.
5. **Commit** the script, `assets.json`, the `.glb` and the manifest.

Something other than a car (a prop, a tree): write a module with a `build(asset)` that uses
`hoodlib` (reset the scene, build `Mesh`es, `to_object`, empties for anchors) and returns a report
`{asset, tris: [...]}`; add a list for it to `assets.json` and to `build.mjs`, and a loader on the
client. Keep the same rules: game frame through `hoodlib.frame`, material slots by name, no set
iteration where order matters (see below).

## Rules that keep it reproducible

- **Deterministic.** `npm run assets` twice gives byte-identical files. bmesh operators (bevel,
  inset) and booleans can emit elements in memory order, so `to_object` sorts faces and vertices by
  geometry and triangulates itself; never hand a Python `set` of bmesh elements to an operator
  (use `hoodlib.mesh.uniq()`); no randomness without a fixed seed. The exporter's generator string is
  replaced with a fixed one, so a Blender patch release does not change the files.
- **No decimation of the near levels.** Collapse decimation across lofted panels loses the window
  and lamp outlines (try `hoodlib.lod.decimate` on a copy and look before using it). The levels of
  detail are built from the spec at lower resolution (`RES` in `cars/builder.py`) instead.
- **Names.** Parody brands or none: no real makers' badges, grilles carry a plain oval at most.
- **Licences.** Everything here is generated (MIT, ours). Blender's output carries no licence
  obligation. If a texture is ever added, it must be CC0 and recorded as `docs/graphics-plan.md` says.

## How the game uses them

`src/client/render/carAssets.ts` loads every asset in the manifest at boot (with `?v=<hash>`, past
the year-long cache on `/assets/*`), bakes the parts into the car's frame, merges the three lamp
kinds into one geometry, and numbers the glass panels. `carModel.ts` draws a full car (the player's,
police, damaged traffic) with levels of detail by distance (`carLod.ts`) and the damage visuals
(`carDamage.ts`: dents, sagging and falling bumpers, the bonnet, broken windows);
`TrafficInstances.ts` draws the rest of the traffic as instances of the same parts.
`carMaterials.ts` holds the paint (grime), chrome, glass (sky reflection, broken panels) and lamp
shaders. `?cars=box` draws the old stand-in box cars instead, for comparison; a failed load does
the same for the cars it affects.
