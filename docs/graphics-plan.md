# Graphics overhaul plan: from white boxes to stylized-realistic GTA IV / V

Status: **P0 and the cheap parts of P2 are done and are the default look** (2026-10-15, on top of `bbba45a`); the rest is still the plan. The owner chose the reference ("make it look like GTA 4. much beyond that and it'll churn too much") and the floor ("iphone 15 pro is a reasonable cutoff"), which answers the first two decisions in section 7. Section 9 says what shipped, where it lives and what is left for the GTA IV target. The proposal below was written against commit `db7cc1a`; sections 4 and 8 describe the spike it grew from.

The owner's note: "graphics are WAY off, but I assume the graphical overhaul comes later." This is that overhaul: a diagnosis, the techniques (with their cost and the tiers that get them), phased milestones, the pipeline changes they need, and a recommendation for what to do first.

- The look target is the README's decision: **stylized-realistic, GTA-like proportions, procedural and CC0 textures, simplified detail**. Not photoreal; GTA IV / V's trick is strong lighting, believable materials and dense detail at street level, with a soft atmospheric haze, over simple geometry.
- Everything must fit [docs/perf.md](perf.md): 60 fps on an M-series Mac, 30+ fps on an iPhone 15 Pro, WebGL2.
- Pictures: `.shots/gfx-before-*.png` (the old renderer) and `.shots/gfx-after-*.png` (the spike), same cameras, and `.shots/gta4-*.png` (the shipped look). They are local (the folder is git-ignored); regenerate with `node scripts/gfx-shots.mjs --prefix gta4` and `node scripts/gfx-shots.mjs --prefix classic --query gfx=classic`.

---

## 1. Where we are

What a frame is made of today (read from the code; numbers from docs/perf.md):

| Part | Today |
|---|---|
| Buildings | One extruded prism per footprint (`tools/pipeline/src/mesh/extrude.ts`): vertical walls, **flat roof**, one vertex colour per building (palette by height and `class`), `bld_glass` for 55 m and up (64 of the 1,058 buildings). White PBR materials with `vertexColors`. No UVs, no floors, no windows, no building parts. Overture gives `height` for 77% and `num_floors` for 45%, and `class` is null for 41%. |
| Ground and roads | Heightmap mesh (4 m cells) and road ribbons, all flat vertex colours; markings are clean vector shapes; no UVs. |
| Lighting | One hemisphere light, one ambient light, one directional light (sun by day, moon by night). One shadow map (High 2048 over 80 m, Medium 1024 over 50 m, Low none), PCF. No image-based lighting, no ambient occlusion, no sky reflection. |
| Sky and fog | Two-colour gradient dome and linear fog (`Atmosphere.ts`, `timeOfDay.ts`): no sun disc, moon, stars, clouds or haze. |
| Colour pipeline | `ACESFilmicToneMapping` and a per-time-of-day exposure. No post-processing, no colour grade, no bloom. |
| Night | `Atmosphere.applyGlow` puts a flat orange emissive on every building material. |
| Cars and people | Box stand-ins (`models.ts`); traffic is instanced (`TrafficInstances`), the crowd is instanced (`PedCrowd`). |
| Props | Signal heads, benches, bus stops. No trees, street lamps, hydrants, bins, signs, power poles. |
| Draw budget | desktop-high worst phase about 560 draws and 283k triangles (budget 740 / 380k); phone-low about 330 and 128k (budget 430 / 170k). CPU is about 1 to 2 ms of the main thread, so **the CPU has headroom; the unknown is phone GPU fill rate**. |

---

## 2. Diagnosis, ranked by impact

Each item says what looks wrong, the evidence in the before shots, and where the fix lands (phases are in section 5).

| # | Area | What is wrong | Fix in |
|---|---|---|---|
| 1 | **Facades and materials** | A tower is a blue-grey slab; a block is a beige slab. No floors, windows, storefronts, parapets or cornices, so nothing says "building" or gives scale (a 150 m tower reads as a 15 m box). At night the whole wall glows flat orange (`gfx-before-street-night`, `aerial-night`): the worst single image in the game. | P0 (spike), P1, P3 |
| 2 | **Lighting** | Hemisphere plus one sun means every face lit by the same colour at the same level; there is no bounce, no sky reflection, no occlusion at the foot of a wall or under a car, a shadow only within 80 m. Day looks like an unlit CAD model. | P2 |
| 3 | **Ground and roads** | Flat grey asphalt, flat pale sidewalks, flat green parks; no wear, joints, kerb shadow, gutters, patches or tyre lines; markings are pristine. The terrain is a smooth drape. The tile ends in a black void at about 1 km (visible in `gfx-before-aerial-day`, top centre; I did not trace the cause). | P0 (spike), P1, P3 |
| 4 | **Atmosphere and sky** | No haze. Atlanta is humid, and distance should wash into a warm milky white; today far buildings stay saturated and sharp. The sky is a gradient with no sun, clouds, stars or moon. | P0 (fog tint), P2 |
| 5 | **Post-processing and grade** | No bloom, so lit windows, lamps and headlights cannot glow; no grade, so noon, dusk and midnight differ only in exposure. | P0 (spike) |
| 6 | **Trees and vegetation** | None at all, in one of the most tree-covered big cities in the US. Streets are bare corridors. Largest remaining "dead city" cue after the facades. | P4 |
| 7 | **Street furniture and scale cues** | No lamp posts, hydrants, bins, poles, signs, awnings, billboards, fences, bollards. Nothing at human scale to compare buildings with. | P4 |
| 8 | **Cars** | Boxes with flat paint, no reflections, no curvature. Reads as a prototype. | P5 |
| 9 | **Characters** | Boxy 13-part figures, no faces or clothing detail. Fine at 20 m, wrong at 3 m from the third-person camera, where the player looks at one the whole game. | P6 |
| 10 | **Roofs and silhouettes** | Every roof is a flat grey lid, no equipment, setbacks or pitched roofs. Visible in any aerial or from a high floor. | P1, P3 |
| 11 | **Weather and night life** | No rain, wet roads, street lights, neon or lit signs. | P7 |

Rule of thumb: items 1 to 5 are 80% of the gap and are mostly **shader and lighting work with small pipeline changes**; items 6 to 9 are **content** and take assets.

---

## 3. Techniques for three.js WebGL2, with cost and tier

"Cost" is for the stated hardware class. The dev box GPU is far faster than any phone, so the phone numbers are estimates until measured on a device (see P0). Tiers are those in `src/client/graphics.ts` (High, Medium, Low; phones start at Medium and the governor steps down).

### 3.1 Facades

| Technique | What | Cost | Tiers |
|---|---|---|---|
| **Procedural window grid (built, `?gfx=next`)** | Fragment shader on `bld_wall` and `bld_glass`: columns fit the wall length in whole numbers, rows fit the height in whole floors (about 3.3 to 4.1 m, per building), podium storefront band on buildings over 16 m, parapet and plinth, slab lines, staining and a grimy base; windows reflect the sky (by day) and are lit per room at night from `nightFactor`. Footprint-edge quads give the wall's start and length, so a window never meets a corner half cut. | ALU only, no texture fetch, no new draw calls. About +0.1 to +0.3 ms GPU on a fast desktop; a phone is fill-rate bound and the cost scales with covered pixels, which the density of Downtown makes large. Fades to an average colour with distance (derivative-based), so no moire. | All (High and Medium full; Low drops the stain and slab-line noise) |
| **A material per building type** | The same shader with a type switch: glass curtain wall; ribbon-window office; punched-window brick or concrete mid-rise; civic (stone, columns); warehouse (few windows, loading doors); house (pitched roof, door, porch); open-deck parking garage (horizontal bands, no glazing); retail strip (awning, big shopfront). Type from Overture `class` and `subtype`, height, floors, footprint shape, and OSM tags, resolved in the pipeline. | One shader program per type group (4 to 6 programs), shared across chunks. Watch shader compile time on iOS. | All |
| **Texture atlas for the "real" detail** | Windows, brick, concrete panel, stone, metal cladding, shopfront and door sprites from CC0 sets, packed into one 2048² (or two) atlas per type group, sampled by facade UV. Gives hand-made variety the procedural grid cannot, at the price of one texture fetch (plus normal and ORM on High). | 1 to 3 fetches per pixel. KTX2 ASTC: 2048² at 4x4 is 4 MB per map, 6x6 about 1.8 MB. | High: albedo, normal, ORM; Medium: albedo and ORM; Low: albedo only, or procedural |
| **Hero landmarks** | Built by hand in Blender (README list: stadium, Gold Dome, Bank of America Plaza, ...). | See 3.8. | All, with LODs |

### 3.2 Texture sources (CC0 only)

All textures are generated procedurally or taken from CC0 sources. Record every file in `assets/LICENSES.md` with its URL and download date. **Do not use anything not CC0** (no CC BY, no "free for personal use", no scans from a game).

| Source | Licence | Use |
|---|---|---|
| **ambientCG** (ambientcg.com) | CC0 1.0 Universal ("All ambientCG assets are provided under the Creative Commons CC0 1.0 Universal License"; verified 2026-10-15 at docs.ambientcg.com/license) | PBR sets for asphalt, concrete, paving, brick, plaster, metal cladding, roof membrane, grass, gravel. Pick 1K sets (resolution variants are listed on each page), AO and roughness packed. |
| **Poly Haven** (polyhaven.com) | CC0 ("Our assets are all licensed as CC0"; verified 2026-10-15 at polyhaven.com/license) | Textures like the above; **HDRIs** for the reflection test environment and for grading references; models for hero props if they suit the style. |
| **Kenney** (kenney.nl) | CC0 | Optional: low-poly props as a style reference or a stand-in. |
| **Generated** | n/a (ours, MIT) | Window sprites, shopfront atlas, decals (cracks, oil, manholes, tyre lines), noise LUTs, all made by scripts under `tools/textures/` from procedural recipes, so they are reproducible and have no licence question. |

Tooling licences: three.js and `KTX2Loader` (MIT); KTX-Software `toktx` and Basis Universal (Apache 2.0); meshoptimizer (MIT); glTF-Transform (MIT); Blender (GPL, but its output carries no licence obligation).

### 3.3 UVs and the KTX2 pipeline

What the pipeline must emit (it emits only `POSITION`, `NORMAL`, `COLOR_0` today; details in section 6):

- **Walls: box-projected is exact, so not triplanar.** A wall is a vertical quad on a footprint edge, so `uv = (metres along the footprint ring, metres above the building base)` is a perfect planar mapping and costs one fetch. Triplanar is three fetches; keep it for the terrain only.
- **Roofs:** `uv = world xz` in metres (the shader can compute it, so none is stored).
- **Roads:** `uv = (metres across the carriageway from the left edge, metres along the centreline)` and a `v` for distance to the nearest kerb. This gives lane wear, tyre lines, gutters and kerb shadow without a baked texture.
- **Ground:** world xz, triplanar only on slopes over about 30 degrees (rock and cut banks).
- **A material id per vertex:** a custom `_MAT` attribute (or the unused alpha of `COLOR_0`) holds the building type, so a chunk stays one draw call.
- **KTX2:** textures are authored as PNG, packed to atlases and compressed with `toktx` to **UASTC** (high quality: normals, ORM) and **ETC1S** (albedo, small), loaded with three's `KTX2Loader`, which transcodes to ASTC on iOS and Apple Silicon, BC7 on desktop, ETC2 elsewhere. Budget: under 12 MB of KTX2 on the wire for all atlases, under 40 MB of GPU memory at High, under 16 MB on a phone (the iPhone's per-tab ceiling is the hard limit). Mipmaps always; anisotropy 4 to 8 on roads.

### 3.4 Lighting

| Technique | What | Cost | Tiers |
|---|---|---|---|
| **Sky as the light source** | Render the sky (a real sky shader with sun disc, moon, stars and soft clouds, replacing the gradient dome) into a 64 to 128 px cube map when the clock moves 5 game-minutes; derive (a) **spherical-harmonics ambient** (three's `LightProbe`, 9 coefficients, read back once per update) in place of the hemisphere light, and (b) a **PMREM specular environment** (`PMREMGenerator.fromCubemap`) for glass, cars and wet roads. | SH: free per frame. PMREM: about 1 to 3 ms once per update. Per-fragment env sampling: 1 fetch on materials that opt in. | SH on all tiers; specular env on High and Medium for glass and cars; Low none |
| **PBR** | The materials are already `MeshStandardMaterial`. What changes is the inputs: ORM maps (atlas) or procedural roughness, real metalness for glass and car paint, clear coat on car paint (`MeshPhysicalMaterial` on the hero car only). | Neutral on walls; clear coat only on a few cars. | All |
| **Shadows** | Now: one map, 80 m. Plan: **2 cascades on High** (near 40 m at 2048, far 200 m at 1024, using three's `CSM` example or a small custom split), **1 larger map on Medium** (1024 over 90 m, fade out), **none on Low**, with a **blob contact shadow** (an instanced dark quad under every car and person) on Low and as a supplement on Medium. Stable texel snapping stays. | A cascade is about +100% of the shadow-pass draws (on today's counts: about 100 to 150 draws on High). That is the biggest line item on draws. | High 2, Medium 1, Low blob |
| **Baked AO in vertex colours** | The pipeline darkens ground, road and sidewalk vertices near walls by distance to the nearest footprint (analytic: `exp(-d / 2.5 m)`), and the shader darkens the lowest 3 m of every wall. Free at runtime; solves "buildings float on the ground". | 0 runtime. Tile grows a few hundred KB (extra vertices on sidewalk strips so the gradient resolves). | All |
| **SSAO** | A half-resolution GTAO (three's `GTAOPass` or the MIT-licensed `n8ao`) with a depth-normal prepass or a depth texture on the scene target. | About +1.5 to 3 ms on a mid desktop GPU; not viable on phones. Needs a depth texture (not in the spike). | **High only** |
| **Real lights** | None for now. Street lamps and headlights are emissive geometry plus additive glow sprites and a ground-pool decal, never a `PointLight` (a light that comes and goes would recompile shaders; the README's phone rule is "fewer pool lights"). | Sprites: instanced, 1 draw. | All |

### 3.5 Post-processing, tone mapping, grade, haze

| Technique | What | Cost | Tiers |
|---|---|---|---|
| **Scene into a half-float target, then composite (built)** | `post.ts`: scene to RGBA16F (MSAA 4x where the canvas has it), then bloom, ACES, grade, vignette and dither in one pass. Hooks `renderer.render` on the instance, so nothing outside `next/` changes. | One full-size 8 bytes/pixel target (about 7 MB at 1280x720, about 2 MB at 393x659), one full-screen pass. | All; Low keeps it without MSAA |
| **Cheap bloom (built)** | Soft-knee threshold + 4x4 downsample to 1/4 size, 9-tap separable Gaussian, then a second chain at 1/16 for the wide glow. About 6 small passes. | Tiny: the passes run on 1/16 and 1/256 of the pixels. | High and Medium 2 levels; Low 1 level |
| **Tone mapping** | Keep ACES (the same curve, so day looks as before), then test **AgX** and **Khronos Neutral** against GTA-like references. ACES crushes saturated blues and oranges, which matters for dusk. | 0 | All |
| **Colour grade** | Now: saturation, S-curve, shadow/highlight tint from the time of day (built). Next: a **3D LUT** per time of day (night, dawn, noon, golden hour), 32x32x32 in a 1024x32 PNG, two fetches blended by the clock. Authoring: grade a reference frame in any tool and bake the LUT with a script. | 2 fetches in the composite | All |
| **Haze and aerial perspective** | Now (built): a pale warm fog tint by day and a shorter near distance. Next: replace three's linear fog with **height-and-distance exponential fog with a sun-side in-scatter** by patching the `fog_fragment` chunk in the building, ground and road materials (no depth texture needed, no pass), and match the sky's horizon band to it. | ALU in the materials | All |
| **AA** | MSAA on desktop already. Add **FXAA or SMAA** (one pass) for Low and for phones, which have no MSAA. | 0.3 to 0.6 ms on a phone class GPU (estimate) | Medium (touch) and Low |
| Not planned | Motion blur, depth of field, SSR, volumetrics: too costly for phones and not what the look needs. | | |

### 3.6 Surfaces: wet roads and rain

A single `uWet` (0 to 1) uniform from a weather state (the sim already has a clock; weather becomes a seeded state machine next to it). The road and sidewalk shaders then: darken albedo by 30%, drop roughness from 0.95 to about 0.15 in puddle areas (noise mask on `uv`), reflect the PMREM sky and, at night, fake the **reflection of lit windows and lamps** by sampling the facade's lit-window colour field along the mirrored ray (a cheap analytic approximation, no scene re-render and no SSR). Rain is a screen-space streak sheet plus instanced splash decals near the camera, and the grade desaturates. Cost: ALU in two materials, one extra full-screen layer, a few draws. High and Medium; Low gets darkening and streaks only. Needs the PMREM from 3.4.

### 3.7 Vegetation (trees from the canopy data)

- **Data.** The research doc names the **Meta/WRI 1 m canopy height map** (reported CC BY 4.0; **verify before use** and add the credit to `attribution`). The pipeline finds local maxima in the canopy-height raster (a 5x5 m window) inside the tile, takes the height as the tree height and the area above 2 m as the crown radius, and writes `trees.bin` (x, z, height, radius, species class; about 12 bytes a tree). Where the raster is missing, fall back to OSM `natural=tree` and `natural=tree_row` plus synthetic street trees along sidewalks and in parks (areas are already in `terrain.ts`). Today's Overpass queries do not request tree nodes; adding them is a one-line change.
- **Rendering.** `InstancedMesh`, three levels: LOD0 within 40 m (trunk plus 2 to 3 low-poly crown blobs with vertex-colour gradient and a lit-from-above shader, about 250 triangles), LOD1 to 150 m (one blob plus a cross-quad, about 60), and **impostor billboards** beyond (2 triangles; 8 baked angles from Blender). Opaque geometry rather than alpha-tested leaf cards: overdraw from cards is the usual phone killer. Wind is a vertex shader sine on the crown. Instances are sorted into 256 m chunks so frustum culling works.
- **Budget.** High: at most 1,200 trees drawn at LOD0/1, about +70k triangles and +6 to 9 draws. Medium: 600. Low: 300 plus impostors, about +15k triangles.

### 3.8 Street furniture

Instanced, one `InstancedMesh` per type per near chunk (or `BatchedMesh` when the types merge): street lamps (also the night light pools and glow sprites), fire hydrants, bins, parking meters, bollards, mailboxes, sign poles with street-name blades, bus shelters (exist), power poles with wires in the suburbs, fences, awnings, billboards. Data: OSM nodes (`highway=street_lamp`, `emergency=fire_hydrant`, `amenity=waste_basket`, `barrier=bollard`, `amenity=bench` exists) plus rules along kerbs for the rest (a lamp every 30 m on arterials, a hydrant each block). **Coordinate with Sonnet A (collision and props)**: furniture that blocks movement needs colliders from the same placement list, so the pipeline emits one `props.json` that both read. Budget: about +15 draws and +20k triangles on High.

### 3.9 Cars and characters: Blender hero assets, LOD and impostors

`tools/blender/` (the README plans it; Blender 5.2 is on the dev box) holds headless scripts (`blender -b --python`) that build and export glTF, so every asset is reproducible and reviewable:

- **Cars.** 6 to 8 body shells (sedan, coupe, pickup, SUV, van, taxi, patrol car, hatch) lofted from a few curves, bevelled and subdivided, with a **paint mask** (one material slot the game tints per instance), separate glass, lamp, trim and tyre slots, and a proper wheel. LOD0 about 6 to 8k triangles (the player's car and the 3 nearest), LOD1 about 1.5k (traffic within 80 m, still instanced in the 6-part scheme of `TrafficInstances`), LOD2 the current box stand-in. Paint is a `MeshPhysicalMaterial` with clear coat on the near cars only, the PMREM sky giving the reflections that make a car look like a car.
- **People.** Keep the **rigid-part design** (head, torso, arms, legs as separate meshes driven by `pedPose.ts`) so the crowd stays five instanced draws, but replace the boxes by sculpted parts (a head with a face on a 128² atlas, a jacket, trousers, shoes) with a palette texture and a per-instance outfit index. The player and officers get a skinned mesh with real animation (one draw each). Far people (over 80 m) drop to a single billboard impostor.
- **LOD and impostors for buildings.** Beyond about 450 m a chunk's buildings swap to a merged low-detail mesh (no windows shader, a flat average colour and a procedural silhouette band); beyond 900 m a skyline impostor strip. This also fixes the README's "far impostors" item.
- **Sequencing.** The vehicle and ragdoll work is changing `models.ts` now. The art swap must come after that lands and must keep the `VehicleModel` and `PedModel` interfaces, adding only a `loadHeroVehicle(typeId)` that returns the same shape.

---

## 4. The spike: `?gfx=next` (now the default look, see section 9)

Code: `src/client/render/next/` (`index.ts`, `facade.ts`, `surfaces.ts`, `post.ts`, `glsl.ts`, `uniforms.ts`) and **one guarded line** in `src/main.ts`:

```ts
if (params.get('gfx') === 'next') (await import('./client/render/next')).installGfxNext(game);
```

It is an awaited dynamic import (awaited so the render hook is in place before the game reports ready, which keeps the perf harness's own `renderer.render` wrapper outside it), so without the flag the module is not even downloaded and the default path is **byte-for-byte unchanged** (no material patched, `renderer.render` not wrapped). No tile is re-baked. `?gfx=next&gfxoff=post,facade,surface,haze` turns parts off to see what each costs.

1. **Procedural facades** on `bld_wall` and `bld_glass` (3.1). The two wall attributes (`aWall`, `aBld`) are derived on load from the already-baked geometry (a wall quad is the connected set of its triangles; neighbouring quads with the same span are one building), so this works on the existing `.glb`. The Atmosphere's flat night glow is replaced by lit windows.
2. **Surface detail** (`surfaces.ts`): asphalt patches and wear, sidewalk slab joints, ground and lawn variation, roof tone, marking wear, all from world position and faded with distance.
3. **Post and haze** (`post.ts`, `index.ts`): half-float target, two-level bloom, the same ACES, a time-of-day grade (cooler shadows by day, blue lift at night, warm highlights at dusk), vignette, dither, and a pale haze tint.

What the spike does **not** do (each is in the plan below): no sky reflections or IBL beyond a gradient fake, no AO or SSAO, no cascades, no depth-based haze, no textures, no kerb darkening (the road shader does not know where the kerb is until the pipeline emits road UVs), no trees or furniture, no new car or person.

### Spike measurements

See section 8.

---

## 5. Phased milestones

Effort is in **agent-rounds** (one round = one focused agent session of roughly the size of the recent milestone passes). Visual gain is my estimate of how much of the gap to the target each phase closes (they overlap, so the numbers do not add to 100). Perf cost is per tier against the current budgets; every phase re-baselines `scripts/perf-budget.json` and must pass `leaks` and the soak.

### P0. Promote the spike, and prove it on devices (2 rounds)

- **Changes.** Move `next/` out of the flag: facades, surface detail and the post chain become the default on High and Medium, and the facade and haze on Low (post optional by the governor). Add `fx` fields to `Tier` in `graphics.ts` (`post`, `bloomLevels`, `msaa`, `facadeDetail`) rather than reading the tier name. Fix the night glow in `Atmosphere`. A `gfx` URL option stays (`?gfx=basic` for the old path) for A/B and for bug reports. Add facade-type switch with the 4 to 6 type groups from Overture `class` (no pipeline change yet: height and the hash decide). Real-device pass on the owner's Mac and iPhone (a checklist like docs/deploy.md's): frame time, thermals after 10 minutes, memory.
- **Files.** `src/client/render/next/*` (to `src/client/render/`), `graphics.ts`, `Atmosphere.ts` (small), `Game.ts` (the render hook becomes a post service instead of an instance override), `scripts/perf-budget.json`.
- **Gain.** Large: roughly 50% of the gap (items 1, 4, 5 and half of 3).
- **Cost.** Per spike table below. Expected: +2 to 4 programs, no new draws except about 8 post passes. Phone-low needs a real-device number before it ships there; fallback is facade-only on Low.
- **Risks.** iOS shader compile hitches (8 extra programs); half-float MSAA target memory on phones; the `renderer.render` override interacts with the perf harness (handled: `info.autoReset` is managed); the CPU wall-geometry derivation (about 20 ms for the 33k wall vertices at load) should move to the pipeline in P1.

### P1. Pipeline v2: the data the shaders want (4 rounds, the pipeline lane)

- **Changes.** See section 6: wall attributes, material ids, roof types and building parts, road UVs, AO in vertex colours, more Overture fields, tree and furniture data.
- **Files.** `tools/pipeline/src/mesh/extrude.ts`, `world/buildings.ts`, `sources/overture.ts`, `world/roads.ts`, `world/terrain.ts`, `bake.ts`, `io/glb.ts`, new `world/trees.ts` and `world/furniture.ts`; `docs/contracts/m1-tile-format.md` (the contract changes first, as that doc requires); client reads in `WorldView.ts`.
- **Gain.** Medium on its own (pitched roofs, setbacks, building parts and kerb shading are visible), but it unblocks P2 to P4.
- **Cost.** Tile size +1.5 to 3 MB (UVs and attributes are quantised; limit is 15 MB, now 7.3). No runtime cost. A tile re-bake is required (this is the first phase that does one).
- **Risks.** Overture's `roof_shape` and `facade_*` are sparse; every field needs a heuristic fallback. Building parts and `min_height` can make walls overlap (use the existing clip to roads). Keep the bake deterministic.

### P2. Lighting and sky (3 rounds)

- **Changes.** Sky shader with sun disc, moon, stars and soft clouds; SH ambient and PMREM specular from it; 2 cascades on High and 1 on Medium; blob contact shadows; exponential height fog with sun in-scatter patched into the materials; LUT grade; SSAO on High.
- **Files.** `Atmosphere.ts` (split into `Sky.ts` and `Lighting.ts`), `timeOfDay.ts` (sun and moon already there), `graphics.ts`, materials patches, `post`.
- **Gain.** Large (items 2 and 4, and everything looks grounded). With P0 it is the whole "no longer flat" jump.
- **Cost.** Draws +100 to +150 on High (cascade 2), +0 on Medium and Low; GPU +1.5 to 3 ms on High for SSAO; PMREM 1 to 3 ms every 5 game-minutes.
- **Risks.** Cascade seams and shimmer; PMREM spikes during a driving scene (spread over frames); the real iPhone fill-rate cost of the SH shader.

### P3. Textured materials: atlas, normal maps, triplanar terrain (3 rounds)

- **Changes.** The KTX2 pipeline and the CC0 atlases (3.2, 3.3): facade atlas by type, asphalt and sidewalk sets with the road UVs, grass and soil on the terrain (triplanar on slopes), roof membranes. Procedural stays as the Low path.
- **Files.** `tools/textures/` (new: pack and `toktx` scripts, `assets/LICENSES.md`), `src/client/render/materials/*`, `WorldView.ts`, `vite.config.ts` (Basis transcoder as a static asset, copied the way the Rapier WASM is).
- **Gain.** Medium to large close up (the difference between "clean CG" and "real surface"), small at distance.
- **Cost.** +1 to 3 texture fetches on building, road and ground fragments; GPU memory +25 to 40 MB on High, +12 to 16 MB on a phone; first-load +6 to 12 MB gzipped (stream after the first frame).
- **Risks.** Memory on iPhone (the hard ceiling); texture streaming hitches; seams between atlas cells at mip level (pad the cells).

### P4. Trees and street furniture (3 to 4 rounds)

- **Changes.** 3.7 and 3.8, placed from the pipeline's `trees.bin` and `props.json`; the night street lamps with glow sprites and pools.
- **Files.** `src/client/render/Trees.ts`, `Furniture.ts`, `tools/blender/` (tree and prop scripts), pipeline `world/trees.ts`, `world/furniture.ts`, `ScenarioProps.ts` (merge). Colliders in the sim: **Sonnet A's lane**.
- **Gain.** Large for street-level feel (item 6 and 7); this is when the city stops looking like a model.
- **Cost.** High +15 to +25 draws, +90k triangles; Medium +60k; Low +15k. CPU: nothing per frame beyond the chunk visibility pass.
- **Risks.** Tree density versus the 3M-triangle and phone budgets (the caps above are the guard); placement quality from the raster (verify the canopy licence first); collisions.

### P5. Cars (3 rounds, after the physics work on `models.ts` lands)

- **Changes.** Blender-built hero and traffic bodies, LOD chain, paint with clear coat and the PMREM reflection, damage as vertex deformation or panel swaps.
- **Files.** `tools/blender/cars/*.py`, `public/assets/vehicles/*.glb`, `models.ts` and `TrafficInstances.ts` (loader behind the same interfaces).
- **Gain.** Medium to large (the car is on screen all the time in the driving half of the game).
- **Cost.** About +6k triangles per near car; 3 near cars at LOD0, so about +20k; instanced traffic stays at 6 draws per type.
- **Risks.** Collision hulls and handling data must not change; art direction needs the owner's eye early.

### P6. Characters (3 rounds)

- **Changes.** 3.9: sculpted rigid parts for the crowd, a skinned hero for the player and officers, outfit palette, impostors.
- **Files.** `tools/blender/peds/*.py`, `PedCrowd.ts`, `models.ts`, `pedPose.ts` (the joint solver stays).
- **Gain.** Medium (the player's character is always in view, so it matters more than its triangle share suggests).
- **Cost.** Crowd +15k triangles on High; skinned hero one draw.
- **Risks.** Animation scope creep; do not start until the ragdoll work is done.

### P7. Weather, night life, neon (2 rounds)

- **Changes.** 3.6, weather state in the sim's clock, lit signs and storefront emissives from the pipeline's shop data (`scenarios.json` already has shop and eatery points), headlight pools.
- **Gain.** Medium; large for mood in screenshots and trailers. **Cost.** Small; rain layer 1 draw.

### P8. Far city and landmarks (3 to 4 rounds)

- **Changes.** Building LOD chain and skyline impostors; hand-built hero landmarks (README list), the tile edge fade (the black void).
- **Gain.** Medium from the aerial and the highway; needed before the map grows past one tile.

**Total:** about 24 to 28 agent-rounds. The first 5 (P0 and the start of P2) are the biggest visual step.

---

## 6. Pipeline changes needed

Everything below goes into `docs/contracts/m1-tile-format.md` first.

| Output | Today | Needed | Why / used by |
|---|---|---|---|
| **UVs on walls** | none | `TEXCOORD_0` = (metres along the footprint ring from the ring start, metres above the base). | Atlas facades (P3); replaces the load-time derivation of `aWall`. |
| **Wall quad data** | derived on the client | `_WALL` attribute (base y, top y) per vertex, or derive from UV and a per-building `_BLD` (below). | The shader's floors and columns (P0 uses the derived version). |
| **Building id and type** | none | `_BLD` = (building hash 16-bit, type id 8-bit, floors 8-bit) per vertex; `bld_wall` stays one material per chunk. | Material per building type, stable per-building variation, night windows. |
| **Roof types** | flat prism | `roof_shape` from Overture (`flat`, `gabled`, `hipped`, `pyramidal`, `dome`) and OSM `roof:shape`; geometry for gabled, hipped and pyramidal in `extrude.ts`; flat roofs get a parapet lip and `_ROOF` equipment placeholders (instanced boxes: HVAC, stair towers, water tanks) from a seeded layout. | Silhouettes, aerial views, the "Lego lid" problem (item 10). |
| **Building parts** | one footprint, one height | Overture `building_part` features (`min_height`, `height`, `roof_*`) and `has_parts`: a podium, a setback tower and a crown become separate extrusions. Stepped heights, bridges, overhangs. | Towers stop being straight prisms. |
| **More Overture fields** | `id, height, num_floors, class, subtype, is_underground` | add `roof_shape`, `roof_material`, `roof_color`, `facade_material`, `facade_color`, `min_height`, `has_parts`, `names.primary` (landmark matching); keep the `class`-null fallback chain (OSM tag, footprint area and height heuristic). | Types and colours. 41% of footprints have no `class`. |
| **Road UVs** | none | `TEXCOORD_0` = (metres across from the left edge, metres along); a second value for distance to the kerb. Sidewalk strips the same. | Lane wear, tyre lines, kerb darkening, gutters, wet-road puddle masks (P2, P3, P7). |
| **AO in vertex colours** | none | Multiply ground, sidewalk and road vertex colours by `1 - 0.45 * exp(-d / 2.5)` where `d` is the distance to the nearest footprint wall; add vertices on sidewalk strips as needed. | Grounds the buildings with no runtime cost. |
| **Trees** | none | `trees.bin` (x, z, height, radius, class) from canopy-height local maxima; fallback OSM trees and synthetic street trees. | P4. |
| **Furniture** | none | `props.json` (type, x, z, yaw, height) from OSM nodes and kerb rules; shared with the sim for colliders. | P4. |
| **Landmarks** | none | `landmarks.json` placement from the city pack, with footprint cut-outs so the generic extrusion does not overlap the hero model. | P8. |
| **Terrain detail** | 4 m heightmap | A 1 m detail layer (normal map or micro-displacement) is not needed; instead a `_SLOPE` or the triplanar shader derives slope from the normal. | P3. |

Bake and file-size guard: quantise UVs to 16 bits, keep meshopt. Tile is 7.3 MB now (limit 15 MB); this adds roughly 1.5 to 3 MB. The determinism check in `npm run verify` stays.

---

## 7. Recommendation: what to do first

**Do P0 first, and start P1 in parallel on the pipeline lane.**

1. The spike already closes roughly half the visible gap for no new draws and no re-bake. Productising it is the cheapest large win available, and it is what the owner will see first.
2. Gate it on the real-device check (an iPhone 15 Pro and the Mac) **before** the rest: the single biggest unknown is phone fill rate, and P2 to P4 all add to it. If the phone number is bad, the tier fields from P0 are what let us cut cleanly.
3. P1 (pipeline v2) is the long pole for everything textured, so it should start at once, with the contract doc change first.
4. Then P2 (lighting and sky), then P4 (trees and street furniture), then cars. Characters and cars wait for the physics agent's work in `models.ts`.

Decisions I need from the owner:

- **Reference direction:** GTA IV (muted, hazy, overcast, grimy) or GTA V (saturated, high contrast, golden light)? The grade and sky differ. The spike leans V-by-day, IV-by-night.
- **Minimum phone target:** is the iPhone 15 Pro the floor (as perf.md says), or should an older phone work (then post is off and facades are simpler)?
- **Pipeline lane:** who owns P1 (it touches the bake that others depend on)?
- **Canopy data licence:** approve the Meta/WRI canopy map (reportedly CC BY 4.0; I have not verified) or prefer OSM and synthetic trees only.

---

## 8. Spike measurements

Box: the perf.md dev box (Radeon 8060S, headless Chromium, 1280x720), 2026-10-15, on a clean checkout of `db7cc1a` plus the spike. `npm run perf-budget`-style runs (`--repeat 2`, best timings, worst counts), without the flag and with `--query gfx=next`. The box was shared with other agents, so **timings are noisy (about +-0.5 ms CPU); counts are exact**.

| Profile (worst of idle, walk, drive, look) | Draws | Triangles | GPU p50 (timer queries) | GPU p95 | CPU mean (main thread) |
|---|---|---|---|---|---|
| desktop-high | 566 -> 574 (+8) | 285k -> 285k | 0.17 -> 0.35 ms | 0.57 -> 1.06 ms | 1.5-1.7 -> 1.9-2.6 ms |
| desktop-medium | 551 -> 567 (+16, within route noise) | 268k -> 265k | 0.24 -> 0.33 ms | 0.55 -> 0.87 ms | 1.9-2.5 -> 1.8-2.1 ms |
| desktop-low | 408 -> 412 (+4) | 167k -> 168k | 0.10 -> 0.21 ms | 0.34 -> 0.70 ms | 1.3-1.5 -> 1.3-1.9 ms |
| phone-low (4x CPU) | 324 -> 330 (+6) | 105k -> 112k | 0.14 -> 0.28 ms | 0.17 -> 0.31 ms | 2.5-4.7 -> 2.8-6.0 ms (one phase each way; noisy) |

A cleaner GPU number from `gl.finish()` around `renderer.render` on fixed cameras (street canyon and aerial, mean of 210 frames; the same box):

| Tier | View | Default | `?gfx=next` | Without post | Without facade | Without surface |
|---|---|---|---|---|---|---|
| High | street, day | 1.36 ms | 1.64 | 1.30 | 1.26 | 1.49 |
| High | aerial, day | 1.88 | 2.53 | 1.85 | 2.43 | 1.64 |
| Medium | street / aerial | 1.60 / 2.36 | 1.69 / 2.28 | | | |
| Low | street / aerial | 0.73 / 1.26 | 1.17 / 1.95 | | | |

So on this GPU the whole spike costs roughly **+0.2 to +0.7 ms**, mostly the post chain at full resolution and the facade shader in dense views. Neither is a prediction for a phone: the post chain is memory-bandwidth bound (one extra half-float target) and the facade shader is fill-rate bound, so a real-device number is the first gate of P0.

Other costs, exact:

- **Draws:** +4 to +8 (the post passes: the scene is drawn once, plus 6 small bloom passes and the composite; the bloom chain is 5 on Low).
- **Triangles:** none (the 1k to 3k differences are route noise).
- **Textures:** +5 render targets on High and Medium (`textures` 6 -> 11, so that budget line reads OVER; it is a budget of 8), +3 on Low (4 -> 7). GPU memory: one RGBA16F target (about 7 MB at 1280x720, plus a 4x multisampled copy of about 30 MB where the canvas has MSAA, i.e. desktop High and Medium) and about 1.5 MB of small targets; on the phone profile (393x659, no MSAA) about 2 MB in all.
- **Programs:** 16 -> 28 (the 2 facade variants, 6 surface variants and 4 post passes; the leak harness shows them stable). Shader compile on first use is the thing to watch on iOS.
- **Heap:** +1.7 to +2 MB. **Boot:** +50 to +85 ms (the module, and about 20 ms to derive the wall attributes).
- **Leaks:** `npm run leaks -- --phases reload --scale 0.5 --query gfx=next` passes (flat heap, geometries 224 -> 224, textures 8 -> 8, objects 912 -> 912), and passes without the flag.
- **Default path:** with no `?gfx=next` nothing changes: the spike is a separate chunk (`dist/assets/next-*.js`) that is never requested, the hook is one line in `main.ts`, and `npm run perf-budget` reports the same draws, triangles and heap as before. (On this busy box the p95 CPU tripwires of the existing budgets were over on desktop-medium, desktop-low and phone-low, in a run without the flag, so they say nothing about the spike; every count budget passed.)


---

## 9. What shipped: the GTA IV look (P0 and the cheap part of P2)

The owner's target is **GTA IV in Atlanta**: muted and slightly desaturated with a grimy yellow-green and brown cast by day; humid, hazy, soft air that fades into warm grey, a diffuse sun and soft pale shadows; at night sodium-vapour orange on the streets with cooler and warmer windows, bloom, a dark but not black sky with a glow at the horizon; dirty asphalt, darker foot of the walls, worn markings; a warm smoggy dusk and dawn. Stylised-realistic and cheap; nothing from GTA V's feature list.

**It is the default.** `?gfx=classic` (or `basic`) is the old flat renderer; `&gfxoff=post,facade,surface,haze,lamps,bloom` turns one part off for an A/B test. The code is in `src/client/render/look/` (the spike's folder, renamed), `Atmosphere.ts`, `timeOfDay.ts` and `graphics.ts`. `?gfx=next` is still accepted and means the default.

| Part | Where | What it does |
|---|---|---|
| Tier fx | `graphics.ts` `Tier.fx`, `resolveFx` | `facade`, `surfaces`, `lamps` 0/1/2, `post` 0/1/2 (1 = a single grade pass), `bloom` 0/1/2 levels, `haze`. The table is in docs/perf.md. |
| Palettes | `timeOfDay.ts` `GTA4`, `CLASSIC` | Anchors for day, dusk and night (sky, sun, sky light, ground bounce, exposure, haze range, shadow darkness and softness) blended by the clock. The sky light tracks the sky colour. |
| Grade | `timeOfDay.ts` `gradeLook`, `look/post.ts` | Analytic per-time-of-day grade after ACES: saturation, S-curve, lifted blacks, shadow, mid-tone and highlight tints, vignette, bloom. No LUT: ten numbers per anchor cost nothing and need no texture. |
| Haze | `look/fog.ts` | The fog chunk is replaced once: exponential, so the air is a little hazy from the first block and thickens smoothly, with the range set by the clock (1,700 m by day, 1,300 at dusk, 900 at night; shorter on Low). `fog.near < 0` selects it, so `gfxoff=haze` keeps three's ramp. |
| Sky | `look/sky.ts` | A dome drawn after the opaque scene (depth at the far plane, so it is shaded only where nothing else is): hazy gradient, a soft sun glare, drifting overcast cloud that the city lights from below at night, stars, a pale moon. |
| Sun and shadows | `Atmosphere.ts` | By day the sun is weaker (1.55 against 2.2), the shadow intensity 0.72 and the PCF radius 3 texels (2 at dusk), so shadows are pale and soft; at night they are as before. |
| Facades | `look/facade.ts` | Windows laid out from the pipeline's mesh-format-2 attributes (`TEXCOORD_0`, `_WALL`, `_BLD`, `_BID`): floors and the ground band from the data, and a layout per building kind (glass curtain wall, ribbon office, punched brick and housing, open garage bays, shopfronts, civic piers, small high industrial windows, none on sheds). The baked colours muted and browned, a dirty base, splash and soot, rain streaks under the sills, hazy greenish glass, tungsten and fluorescent rooms, sodium spill on the lower floors. A tile without the attributes gets them derived from the triangles on load (the spike's method, laid out by height alone). |
| Surfaces | `look/surfaces.ts` | Worn asphalt with repair patches and cracks; **from the baked road UVs** a dark gutter along the kerb, wheel tracks and oil down every lane, a pale kerb stone and dirt behind it and slabs that line up with the walk; **from `_LAND`** lawn, bare earth and paving weights; **from `_SRF`** shingled slopes, parapet caps and metal rooftop boxes. Dull olive lawns, dirty cream markings. Every surface (and the facade) multiplies its sky light by the baked ambient occlusion in the alpha of `COLOR_0` (65%: the street canyon is dark, not black). |
| Street lamps | `look/lamps.ts` | The 2,087 lamps of `props.json` (yaw, pole height and kind: cobra-head arm, pedestrian post, tall mast), or, for a tile without it, a stand-in placed from `roads.json` and `junctions.json` (one every 34 m on streets, 44 m on small ones, alternating sides). Instanced draws near the camera: a glow card at each head (additive, HDR, so it blooms), a pool card on the road that **multiplies** the surface (so paint and pale slabs glow and dark asphalt stays dark) plus a weak additive twin, and a pole. No real lights. |

**What the look does not do yet, for the GTA IV target:** car and person materials and lighting (the car shader is the Blender lane's), trees (`props.json` has 4,185 anchors and nothing draws them), lamp poles are visual only (the sim has no colliders for `props.json` yet), headlight pools, wet roads and reflections, a real sky reflection in the glass, and the textured detail of P3.
