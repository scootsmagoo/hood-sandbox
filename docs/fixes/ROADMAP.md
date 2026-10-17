# Fixes roadmap

Known problems, worst first. Owner reports carry a screenshot. Agent findings carry coordinates in game metres, with x east and z south of Five Points, on the M1 tile. Remove an entry when it ships, and record the fix in its commit.

Last updated 17 Oct 2026.

## P1: Roads and overpasses (owner, 16 Oct; round five, 17 Oct)

Round five (`docs/ground-audit.md`) fixed the barrier box on the Capitol Square SW stub and the GPS there (verify: 0 lanes through
or ending against a barrier, 0 deck lanes off the main network), brought dead deck ends down or walled them, and draped large
junctions. What is left:

### 1. Overpass humps and blunt deck ends near the Capitol and I-20

![overpass hump](overpass-hump-capitol.jpg)

- **The hump** in the owner's shot is the service ramp 1451206631 / 561203364 / 561203367 at (224, 735) to (230, 768): it climbs
  2 m from the ground onto the loop over the Connector and is drawn the same as before (`.shots/round5/*-capsq-stub-low.png`). It
  goes on now (the barriers are open and its lanes are on the network), but it still reads as a hump from the ground: a short
  steep ramp with a curved barrier.
- **Deck ends that meet nothing and stand off the ground** (walled now, not drops): 562648391 at (-394, -111) 7.4 m,
  561694954 at (166, 915) 4.5 m, 1280097288 at (-384, -114) 1.7 m, 1266333950 at (-598, 73) 1.2 m.
- **Steep deck joins** (verify's grades): Capitol Avenue 563545714 at (191, 831) 24% over 5 m, 547758714 at (722, -848) 21%,
  service roads 563545717 at (126, 831) 18% and 561203363 at (269, 813) 17%.
- **Memorial Drive over I-20, Capitol Avenue's join** (200, 812): Capitol Avenue climbs 0.7 m over 6 m where it leaves the deck it
  takes the height of (46 audit events there; 2 hull-ghost launches on smooth road at (202, 811) in the M2 tile `0_0`). A 15 m fade
  of the join fixed the climb but was dropped for a ghost launch elsewhere (`docs/ground-audit.md`, round five).

### 2. Junction surfaces: a raised hump mid-road

![junction blobs](junction-blobs-hump.jpg)

- The blobs (the ground showing through the fan of a large junction) are fixed: junctions are cut by the heightmap's cells and
  draped (`.shots/round5/*-junction-w-738-406.png`). Not checked at the owner's junction (its place is not known).
- **Still open:** the short raised hump on an otherwise flat street (road-profile crests on short ways); find the place first.

### 3. Ground residuals (agent findings, the round-five tile)

- **Seam launches**: 116 of 132 launches are on seams (the map's steps under a car's footprint). The worst places:
  - the Connector fork (919, 283) and (952, 263): deck ends landing at the junction;
  - Pryor St over the rail gulch (704, -844), (719, -833), (719, -846);
  - MLK Dr and the I-20 ramps (394, 656), (355, 629), (378, 645);
  - Northside Dr (-561, 203);
  - Memorial Dr over I-20 (200, 812);
  - wide-carriageway edges (930, 164);
  - (-461, 78): unexplained deck pushes and a slab edge; (-848, -166).
- **The Connector's two carriageways** at (690, 480): 3 m apart and 4 m apart in height.
- **A walk ramp under a deck's slab** at (492, 678): the sidewalk ramp 7090 to 7094 in `paths.json` falls from -9.6 to -13.8 m
  under a slab by the end of MLK Jr Drive's bridge 755543581 (its top -9.1 m there); a person put on it is stuck between the slab and the ground (the
  collision audit's player, 17 windows; the same in round four's tile).
- **M2 seams** (the full bake): 186 lane ports of 1982 unmatched. Of 194 (before the key match): 44 have the same lane across
  within 1 m but more than 0.25 m off in height or far off in heading (1467386397 at (0, -1493): 0.26 m; 9275841 at (2048, -1706)
  is on another level), 52 at 1 to 5 m and 48 further along the line (a lane count that changes at the seam: 337901447 at
  (0, -1603)), 27 where only the other direction crosses (9275841 along x = 2048), 21 another road, 2 nothing. Ways 631611892,
  1040543348 and 9245347 now match, and the northbound lanes of `0_0` that stopped 1 to 4 m short of z = 0 reach it (one left:
  1034188590 at the tile's corner, (1024, 4.2)). The largest port step is 0.25 m on lanes and 0.54 m on walks.
- **M2 ground audit** (the four downtown tiles): `0_0` fails the M1 gate (2 launches on smooth road, jolts 14.8 and pushes 2.8 per
  10 km); `-1_-1`, `0_-1` and `-1_0` pass.

## P2: Gameplay and world

- **GPS:** walking turns near unnamed service roads show blank street names.
- **Aim pose** (the upside-down bend is fixed): at +45° and above the pistol arms go almost straight up, and the rifle sits 10–20° low when aiming up. Crouched aim is never played (the sim never sets crouch and aim together).
- **Big map:** no parks or water yet (needs the tile's land-class mesh), and the hint line can sit over labels.
- **Georgia State Capitol hero:** the main portico faces **west onto Washington St**. Remove the extra east portico (`landmarks.json` note).
- **Landmark positions:** 25 still unverified (`landmarks.json` notes). Overpass was overloaded.
- **People:**
  - The face is a painted mask; fingers exist only up close.
  - Get-up animations are built but not played.
  - The rifle mount is roughly tuned, and shoes are a bit platform-like.
- **Trees:** a visible switch between detail levels at about 30 m, and distant trees are plain silhouettes at night.
- **Car sodium light:** strength set to 0.35 by eye; check at night.
- **Peds on freeways:** fixed in round 9. Recheck after any M2 bake. (Round five: a traffic car on a junction curve between deck
  lanes was put on the ground under the deck, crashed into the freeway's cars at (255, 820), and its driver walked on the Connector;
  junction curves off deck lanes are on the deck now, `LaneGraph.ts`.)

## P2: Harness and performance housekeeping

- **`perf-budget`:** budgets are stale after rounds 8–9 (landmarks, trees, people, freeway traffic). Re-baseline on a quiet machine (load under 2) by hand: best of two runs, and no `--write-budget` on noisy p95 values.
- **The 5-minute soak:** re-run on a quiet machine. The last run was at load 23, so its CPU-per-draw drift isn't meaningful.
- **Real devices:** the Mac measured 120 fps in Chrome. The iPhone 15 Pro hasn't been checked yet; see the checklist in `docs/deploy.md`.

## In progress (16 Oct)

- **Peach Rapid Transit:** tunnels, stations, trains and riding.
- **Hartsfield-Jackson:** its own tile region, terminals, an interior and AI aircraft.
- **The M2 bake** (Midtown, Inman Park, Little Five Points, Candler Park, Buckhead, Vinings): waits on the Overpass prefetch, which keeps hitting 502 and 500 errors.

## Tools now on the dev box (owner, 16 Oct)

- **Installed:** ffmpeg, espeak-ng, the gltf-transform CLI, the Piper TTS engine (`~/.local/share/piper-venv`, **no voice yet**), toktx/KTX v4.4.2 (`~/.local/bin`), and **MPFB2 v2.0.18 with the MakeHuman assets** in Blender 5.2.2. MPFB2 works in the GUI; headless use is untested.
- **Next uses:**
  - Try MPFB2 headless as a base for more realistic people (CC0 assets).
  - KTX2 textures for P3 of the graphics plan.
  - Piper barks once a voice with a confirmed redistributable licence is picked. Avoid ryan-high and lessac; en_US-amy is unconfirmed.
- **Licences:** log every third-party asset in `assets/LICENSES.md`.

## Later (owner wish list)

- **Flyable aircraft and helicopters** you can steal (the airport's aircraft entities are designed for it).
- **The rest of the metro:** the M3 compression warp, the King and Queen towers, Stone Mountain and the lakes.
- **Voice and dialogue,** once licence-safe voices are picked (`docs/tools-wishlist.md`).
