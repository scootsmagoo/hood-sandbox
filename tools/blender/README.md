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


## Trees and street furniture (`props/`)

`npm run assets` also builds `public/assets/props/trees.glb` and `furniture.glb` (listed under `"props"`
in `assets.json`; manifest `src/client/render/propAssets.manifest.json`). Plain-Python geometry
(`props/geo.py`: tubes, lathes, boxes, noisy blobs and leaf cards, no bmesh) with smooth custom
normals, a linear albedo in `COLOR_0` and a code in its alpha (a leaf card is 0.55 to 1, anything solid
0 to 0.45, both carrying a wind weight; see `geo.py`). All sizes come from `src/shared/data/propDims.json`,
the file the sim's colliders read, and `props/verify.ts` (run by `tests/anchorProps.test.ts`, so by
`npm run assets`) measures the exported models against it.

| File | Contents |
|---|---|
| `props/trees.py` | Five species (willow oak, sweetgum, loblolly pine, crape myrtle, red oak), each as `tree_<name>_lod0` (near: trunk, limbs, opaque core blobs and alpha-tested leaf cards, 700 to 1,200 triangles) and `_lod1` (mid: trunk, a few limbs, 7 or 8 low-poly clumps, 350 to 480). The far level is not built here: the game bakes impostors from `lod0` at load. |
| `props/furniture.py` | `lamp_cobra`, `lamp_post`, `lamp_mast` (each with a `<name>_anchor` at the lamp head: the game puts the glow, the pool and the sodium light there), `hydrant`, `bin`, `bollard`. 180 to 340 triangles each. |

Leaf shapes are not textures: the shader computes the leaves of a card (`leafMask` in
`src/client/render/Trees.ts`), so there is no image to licence or to stream. Adding a species: add it to
`propDims.json` (`trees`, in the order of `TREE_NAMES`), to `STYLE`, `NAMES` and `structure()` in
`trees.py`, and to `LEAF` in `Trees.ts`, and give `treeSpecies()` in `src/shared/props.ts` a rule for it.

## People (`characters/`)

`npm run assets` also builds `public/assets/characters/characters.glb` (`characters/build.mjs`, after the
cars and props; manifest `src/client/render/characterAssets.manifest.json`). Everything is written in
Python from numbers: no scan, no sculpt, no mocap, no texture, no third-party model (see
`LICENSES.md`). One armature, sixteen bodies, three levels of detail each, thirty-one clips.

```
node tools/blender/characters/build.mjs                  # build, join, compress, write the .glb and manifest
# preview one figure (Cycles on the CPU, seconds):
/snap/blender/current/blender -b --factory-startup --python tools/blender/characters/view.py -- \
    --arch kudzu --lod 0 --views front,q,back,headq --out /tmp/k [--pose walk:0.25] [--w 600 --h 900]
```

| Module | What |
|---|---|
| `skeleton.py` | The 22 bones (names without dots, `_L` is the figure's left, +X), where each one is, the ragdoll's eleven bodies and the bone each drives, and the material slots (regions) a face can have. Heights follow `src/shared/ragdoll.ts`: pelvis 1.0, hips 0.91, knees 0.49, shoulders 1.45, head joint 1.52, 1.74 m tall, feet on y = 0. |
| `shapes.py` | `Tube`: rings of superellipse sections along an axis (limbs, torso, shoes, straps), with clothing as `Layer`s on it (a span, a material, a thickness, a hem at each end), masks for paint (a zip, a tie, a vest's stripes), and skin weights from the distance to the bones a tube may use (`Weighter`). |
| `body.py` | The parametric body: `Build` (shoulders, chest, waist, hips, bust, belly, limb thickness) and the curves for torso, arm, hand, leg and shoe; one function per part at each level of detail (`LODS`). |
| `head.py` | The head as one grid of vertices (rows of heights, columns of angles), shaped by side and front profiles and gaussian bumps for brow, nose, cheek, lips and chin; hair and beard are offsets on the same vertices with their cover written to the vertex colour (the shader draws the hairline, beard, brows, eyes and lips). Hats (`hat_shell`) and hanging hair (`hair_curtain`). |
| `outfits.py` | The sixteen archetypes (Kudzu, suit, office, casual, cap, hoodie, beanie, dress, student, worker, tourist, layered clothes, officers) as a build, a head and layers, plus extras (boots, belts, holster, pack, hats). |
| `anim.py` | Poses as rotations in the figure's rest axes, forward kinematics, two-bone IK for arms, baking a clip to an action. |
| `clips.py` | The clips: a gait generator (leg IK on a foot path, arm swing, twist, bob) for walk, jog, sprint and flee, and poses with a little motion for the rest (idle, sit, phone, film, cower, chat, ATM, browse, fight, punch, aim, cover, reload, drive, enter and exit a car, dragged, stumble, flinch, fall, get up). |
| `rig.py`, `build.py` | The armature, skinned objects, baked ambient occlusion in the vertex colour (red: occlusion, green: hair cover, blue: beard cover), the report. |
| `build.mjs`, `verify.ts` | Joins each mesh's primitives into one with a `_REGION` byte, drops animation channels that never move, compresses; the checks (`tests/characterAssets.test.ts`). |

A pose angle is a rotation about the figure's X, Y and Z axes (X left, Y up, Z forward) applied to a bone
in its parent's carried rest frame; the exporter's bones point along their own axes, so `anim.py` turns an
angle into the bone's own with `R^-1 d R`, and `src/client/render/chars/ragBones.ts` uses the same rule
the other way round to drive the bones from the ragdoll (`d = Q_parent^-1 Q_part`).

Budgets (the verify step fails outside them): LOD0 3,000 to 5,000 triangles, LOD1 800 to 1,600, LOD2 250 to
650; a person stands on y = 0 and is 1.7 to 1.82 m tall; at most four joints a vertex, summing to one.

Adding a body: write an `Arch` in `outfits.py` (copy the closest one), add its name to `ARCHETYPES` in
`src/client/render/chars/outfits.ts` (same order as `outfits.py` registers them), give an outfit in
`CHAR_OUTFITS` (and the groups of `data/cities/<city>/population.json`) a use for it, `npm run assets`.
Adding an outfit alone (a new colour scheme) needs no Blender: `CHAR_OUTFITS` and `OUTFIT_COUNT`
(`src/shared/entityDefs.ts`, kept equal by a test).

How the game uses them: `src/client/render/chars/` (`characterAssets.ts` loads the file once at boot, `PedViews.ts`
draws every pedestrian: `PedActor` skinned figures with a mixer for the player, officers, the nearest
dozen and every ragdoll, `SkinnedCrowd` for the rest with the clips baked into a texture by `BakedAnims`,
`animSelect.ts` the sim's flags to clips, `ragBones.ts` the ragdoll to the bones, `outfits.ts` who wears
what, `pedMaterial.ts` the shading). `?peds=box` draws the old block figures instead, and so does a
failed load. `scripts/char-shots.mjs` takes the pictures (`.shots/chars-*.png`).

## Hero landmarks (`landmarks/`)

`npm run assets` also builds the hand-built models of real Downtown buildings into `public/assets/landmarks/<id>.glb`, each with
a `<id>.json` sidecar (where it stands, what it replaces, its collision hull, its levels of detail; manifest
`src/client/render/landmarkAssets.manifest.json`). The pipeline reads the sidecars (it suppresses the generic buildings the
models replace and gives them their hull), the client draws the models. The mechanism and the files are in
`docs/contracts/m1-tile-format.md`, "Hero landmarks". They are original interpretations written in Python from public
descriptions and photographs: no third-party model, no copied texture, no brand marks or lettering (see `LICENSES.md`).

```
node tools/blender/landmarks/footprints.mjs              # the real footprints from the pipeline cache -> landmarks/footprints.json (committed)
node tools/blender/build.mjs --only westin-peachtree-plaza   # one model
node scripts/landmark-shots.mjs [--only <id>] [--times day,night]   # .shots/landmark-<id>-<view>-<day|night>.png (needs `npm run dev`)
node scripts/landmark-names.mjs                                      # the street-name label at the landmarks
```

| Module | What |
|---|---|
| `footprints.mjs`, `footprints.json` | Each landmark's anchor (a game point and its lon/lat), the real outline and the Overture parts (floors, heights), so a model is drawn on the real footprint, in the world's axes (no yaw), at the real height. Re-run when the cached Overture release changes. |
| `lm.py` | The geometry kit: `Lod` (one level of detail) with `poly`, `ring_walls` and `facade_quad` (facade quads with the look's per-vertex data: `u` along the wall, `_WALL`, `_BLD` kind/floors/band, `_BID`), `prism`, `box`, `beam`, `tube`, `lathe`, `skin`, `cap`, `merge` (turn a part built in a rectangle's frame into the model frame), `min_obb`; and `emit`, which makes the Blender objects `lod<N>_<material>`. Plain Python lists, welded and deterministic. |
| `parts.py` | Ledges and cornices (`band`), pyramidal roofs, columns, ring simplification. |
| `lm.py` (moving parts) | `Lod.child(name, pivot, props)` makes a sub-level exported as an empty `lod<N>_<name>` at `pivot` with its own meshes under it, `props` in the node's extras: the game turns it or instances it (the wheel, `skyview.py`). `lm_water` is the fountain's animated material (`fountain.py`). See `docs/contracts/m1-tile-format.md`, "Moving parts". |
| `common.py` | `report()`: the sidecar (hull prisms, cut-out, level distances). |
| `<id>.py` | One landmark: `ID`, `build(asset)` that fills a `Lod` per level and returns `common.report(...)`. |

Materials are named for what the game does with them (`lm.py` header). A facade (`bld_wall`, `bld_glass`) is drawn by the look's
window shader, lit at night and dirtied like the baked buildings; give it `floor_h` and a `kind` (`lm.K_GLASS`, `K_OFFICE`,
`K_CIVIC`, `K_BRICK`, `K_VENUE`...). `lm_glow`, `lm_lit` and `lm_flood` are the night signatures (lit rings, a roof lit from
within, a floodlit dome). Budgets (`landmarks/verify.ts`, run by `tests/landmarkAssets.test.ts`): LOD0 up to 40k triangles
(the current ones are 0.15 to 14.4k; a moving part is counted once, its instances are drawn by the game), the far level a few hundred, 400 KB a file, a hull no taller than the model.

Adding a landmark: add it to `HEROES` in `footprints.mjs` (an Overture building by name, or an OSM way) and run it; write
`landmarks/<name>.py` from the closest existing script; list it in `assets.json` under `"landmarks"` with the id of the city pack
(`data/cities/<city>/landmarks.json`, which names it); `npm run assets`, bake (`npm run bake` in `tools/pipeline/`), and look at it
with `scripts/landmark-shots.mjs`.

## Transit (`transit/`)

`npm run assets` also builds the Peach Rapid Transit models into `public/assets/transit/`, each with a `<name>.json` sidecar
(listed under `"transit"` in `assets.json`; manifest `src/client/render/transitAssets.manifest.json`). Parody brand only: no
real transit logos, wordmarks or lettering; every sign face is a blank panel with 0..1 UVs (TEXCOORD_0, u to the viewer's
right, v up) that the game draws its own text on. Checks: `transit/verify.ts`, run by `tests/transitAssets.test.ts`.

```
node tools/blender/build.mjs --only railcar,station-kit --preview /tmp/p   # Cycles previews: cab, side, rear, front, bogie, interior, window, cabin, lod1, lod2; kit overview, platform, gate, canopy, tunnel, walls, lod1
```

| Module | What |
|---|---|
| `tk.py` | The kit both use, on the landmarks' `lm.Lod`: box UVs inside [0, 1] unless given, `sign_quad`, `prism_x`/`prism_y`, `revolve` (wheels, poles, bins), face `grid`s with holes (sides with windows and doors), `bake_ao` (ray-cast occlusion into COLOR_0 alpha), `emit` (one object per piece, one primitive per material; a moving piece is an empty at its pivot over `<name>_mesh`). |
| `railcar.py` | The car, every number from `src/shared/data/railcar.json` (the file the sim boards, seats and collides by; the seats drawn are its `seats`). |
| `kit.py` | The station and tunnel parts. |
| `preview.py` | Look-alike materials for the previews only (swapped back before the export). |

**railcar.glb** (`transit.railcar`): a 22.86 m stainless metro car in the manner of the Atlanta fleet (fluted lower sides, a peach band
with a navy pinstripe, a black-masked cab at +Z with the destination sign box, headlights and red markers, a gangway end door and
couplers at both ends). Car frame: +X the car's left, +Z the cab end, origin on the track centre at rail top, mid-car.

```
railcar                          extras: asset, lod_tris, lod_from [0, 60, 220], leafTravel
  lod0  lod0_body, lod0_interior (floor, linings, ceiling with two light strips, 2 + 2 seats, poles, grab rails, draft screens,
        both end walls, the cab), lod0_bogie_F/_R, lod0_door_{L,R}{0,1,2}_{a,b}
  lod1  lod1_body (exterior, glass over a dark box), lod1_bogie_F/_R, lod1_door_...
  lod2  lod2_body (shell, band and windows as materials, doors and bogies merged)
  anchors  anchor_door_L0..2 / _R0..2 (floor, body side, door centre), anchor_cam_window (extras yaw, seat),
           anchor_headlight (extras spread), anchor_coupler_F/_R
```

A door leaf node is an empty on the leaf's closed centre (the mesh is its child `<name>_mesh`); L is the +X side, R the -X side,
0..2 in `doors.z` order, leaf `a` the -Z half, `b` the +Z half. Opening = moving `a` by -leafTravel and `b` by +leafTravel along z
(extras `slide`): the leaves run in the cavity between skin and lining, and the doorway is clear. Bogie nodes sit on their pivots
(0, 0, +-bogieZ). Glass panes are single quads facing out: draw `tr_glass` double-sided.
Materials: `tr_steel`, `tr_band`, `tr_cab`, `tr_glass`, `tr_dark`, `tr_interior`, `tr_floor`, `tr_light` (emissive strips), `tr_head`,
`tr_tail`, `tr_sign` (front and side destination faces). Budgets: LOD0 16k, LOD1 3.5k, LOD2 500 triangles; 600 KB.
Bounds checked against railcar.json: length, half width, roof, floor, skirt, the couplers within half the gap.

**station-kit.glb** (`transit.kit`): each part a top-level node at the origin with `<part>_lod0` (and `_lod1` for column, bench,
fare_gate, canopy, tunnel_bay, bin): `column`, `bench`, `sign_name`, `screen`, `fare_gate`, `pylon`, `canopy`, `railing`,
`lamp_tube`, `tunnel_bay`, `signal`, `bin`, `map_board` (frames and origins in `kit.py`'s header; sizes, triangles and origins in
`station-kit.json`). Materials: `tr_steel`, `tr_dark`, `tr_glass`, `tr_interior`, `tr_light`, `tr_concrete`, `tr_tile`,
`tr_signface` (blank sign faces), `tr_screen` (the next-train display), `tr_lightface` (lamp and signal lenses, colour in COLOR_0).
Budgets: canopy 2k / 500, tunnel_bay 600, the rest 800; 400 KB. The fare gate's cabinet is the sim's 0.26 x 0.85 x 1.6 collider.

## The airport (`airport/`)

`npm run assets` also builds Hartsfield-Jackson into `public/assets/airport/` (the `"airport"` list of `assets.json`, kind `hero` or
`aircraft`/`ground`; manifest `src/client/render/airportAssets.manifest.json`). [docs/airport.md](../../docs/airport.md) says what is there.

| Module | What |
|---|---|
| `footprints.ts`, `airport.json` | `cd tools/pipeline && npx tsx ../blender/airport/footprints.ts`: the heroes' outlines, anchors and floor elevations, every gate's wall point, jet bridge root, stand, parked yaw, size class and jet bridge tip (the L1 door of that class parked there, from `src/shared/data/aircraft.json`), the SkyTrain's guideway with the ground under it, the rail station. Committed; re-run when the pipeline's airport cache changes. |
| `apt.py` | The shared kit: `hero`, `gates`, `report` (the landmark sidecar plus `elevation`, `flatten`, `interior`, `hooks`; docs/contracts/m1-tile-format.md, "Airport heroes"), hull helpers, `jet_bridge`. |
| `concourse.py`, `terminal_intl.py`, `tower.py`, `decks.py`, `skytrain.py` | Concourses A to F, the international terminal, Atlanta Tower, the parking decks and the Rental Car Center, the SkyTrain. |
| `domestic.py`, `concourse_t.py`, `interior.py` | The two walk-in heroes and their interiors (hull, walk network, scenario points, places, zones). |
| `aircraft.py`, `ac_kit.py`, `ground.py` | The airliners (`ac-narrowbody`, `ac-widebody`, `ac-regional`: one parametric builder over `aircraft.json`) and the airside vehicles (`ac-ground`: tug, baggage tractor and cart, belt loader). Livery regions in the paint's COLOR_0 red (k/7: crown, belly, fin, engines, stripe, accent). |
| `verifyHeroes.ts`, `verifyAircraft.ts` | The checks of `tests/airportHeroes.test.ts` and `tests/airportAircraft.test.ts`. |

