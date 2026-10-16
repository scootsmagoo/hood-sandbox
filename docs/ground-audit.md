# The ground audit

Is the drivable world solid and smooth, and does any road run into a building? `tests/audit/ground/` answers it headless, on a
baked tile, with the real sim code (`PhysicsWorld`, `RaycastCar`, the traffic AI's pure pursuit and speed governor).

```
npm run audit:ground                      # the whole tile at 15, 25 and 35 m/s: about 80 s on 30 threads
npm run audit:ground -- --quick           # every 12th edge at 25 m/s
npm run audit:ground -- --tile <dir> --out <dir> --speeds 25 --workers 8 --gate --no-edge-fix
npm run audit:ground -- --trace           # also every launch's last 45 ticks, wheel by wheel, in ground-traces.json
npm run audit:ground -- --no-guard        # the cars' physics before the crash guard (round four), for a before-and-after
npx vitest run tests/ground.test.ts       # the quick version in `npm test` (a sample of lanes, plus a synthetic regression)
```

It writes `.shots/ground/ground-audit.json` (every event, the counts, the worst spots, the gate numbers) and
`.shots/ground/ground-heat.png` (top-down, 2 m a pixel: footprints dark, lanes grey, every event a dot coloured by kind and sized by
speed; launches and building findings ringed; the swatches along the top edge are, left to right, mismatch, step, crest, prop,
contact, kick, jolt, building, abort, launch, air). `npm run verify` in `tools/pipeline` runs the full audit with `--gate` and
fails the bake when a gate fails (`HOOD_GROUND_AUDIT=quick` or `off` for a quick run or none).

`scripts/ground-audit.mjs` bundles `tests/audit/ground/run.ts` with esbuild (a Vite dependency) into `node_modules/.cache` and runs
it; the bundle is also the worker script (one region of the tile per thread and speed), so it needs no TypeScript runner.

## What it does

1. **Drives every lane.** Every edge of `lanes.json` (lanes and junction curves) is driven by a physics sedan at a target speed of
   15, 25 and 35 m/s, slower where the governor needs to be for a curve (it plans corners at 5 m/s² and brakes at 5.5). A route
   starts at an unvisited edge with a run-up along its straightest way in, chains on through unvisited edges, and crosses others
   (driven, not measured) to the nearest one left within 500 m. A car that is given up on (stuck, more than 6 m off its path, on
   its roof) has the edges it did not reach tried again, twice at most. Nothing is recorded for the first 0.6 s after a spawn,
   until all four wheels have been down for a fifth of a second, or within 6 m of the tile's edge.
2. **Records, every tick** (one event per episode: the same kind within half a second is the same event):
   - `air`: all four wheels off the road for 4 ticks or more, with the car within 4 m of its lane.
   - `launch`: upward speed more than 1 m/s above what the road's grade explains, with a wheel off.
   - `jolt`: the body's vertical acceleration beyond gravity over 18 m/s² in a tick. `kick`: the pitch or roll rate changing by
     more than 0.6 rad/s in a tick.
   - `contact`: the hull pushed by static collision that is not a wall: vertical speed gained in a tick beyond what the wheels and
     gravity explain (more than 0.3 m/s), with what the hull touched. (A contact's own impulse reads 0 in this Rapier, so the push
     is measured on the body.)
   - `abort`: a route given up on while measuring a lane.
3. **Says why** (`cause`), in this order: a wheel on a prop, a car, a pier or a roof; a **ghost** (`ghost-edge-ground`,
   `ghost-edge-deck`: the hull was pushed while its belly and bumpers, sampled over a grid on the floor, were more than 6 cm clear
   of the surface); a **step** between the ground and a deck under a wheel where it crossed, or along the car's track (more than
   4 cm between samples 0.25 m apart beyond the local grade: `surface-step:ground>deck` and so on); the hull on a slab's edge, a
   pier, a wall or a prop; a **crest** or a **sag** too sharp for the speed (curvature over a 3 m chord: v² k over 0.8 g, or 1.2 g
   for a sag); the drawn road more than 0.2 m off the physics (`visual-mismatch`); the hull on the road.
4. **Scans the surfaces** of every lane (its centre and two wheel tracks 0.8 m either side, with mitred offsets): `step`, `crest`
   (the speed it would lift a car off) and `mismatch` (the lane's height against the physics).
5. **Scans the buildings**: every lane and junction curve (its centre and 0.9 m either side) against the footprints at the lane's
   height (`lane-through-building`, `lane-ends-in-building`, `connector-into-building`); every road centreline
   (`main-road-in-building` for a street class, `service-road-in-building` for a service road under a garage or a plaza); every dead
   end (a lane whose only way on is a turnaround, a road end that meets no other road) facing a footprint within 12 m:
   `main-road-dead-ends-at-building` when the wall is within 4 m of the carriageway's end (the road leads a car into the wall),
   `main-road-dead-end-near-building` otherwise (a cul-de-sac in front of a building: reported, not a fault).
6. **Scans the props**: a solid box (pole, trunk, shelter, bench) within 0.95 m of a lane's centreline below 1.5 m (`prop`).

## The gate

`GATES` in `run.ts`: no lane, junction curve or main road into a building, **no launch on smooth road** (below), and a ratchet on
the rest at what the tile measures (a few percent over it): launches 145, steps 135, jolts and kicks 12.5 per 10 km, contacts 2.2
per 10 km, given-up routes 7.5% (round three left 260, 135, 13.5, 3.2 and 8%; round two 270, 195, 17.5, 3.8 and 9%; round one 820,
490, 38, 10.5 and 12%). The quick sample in `tests/ground.test.ts` allows 1 launch, none on smooth road, and 15 jolts per 10 km.
The goal is zero launches: lower the numbers as the residuals below go.

**What made a launch** (`classifyLaunch` in `core.ts`; every launch and airborne episode has an `origin` and a `ground`). The car
keeps a trace of its last 45 ticks: each wheel's ray (hit distance, normal, feature, contact height, suspension length, compression
rate, spring and tyre force) and the body's vertical dv split exactly into the springs, the tyres, gravity and the solver, with
Rapier's contact force events naming what pushed the hull and the hull's exact distance to the ground and the decks before the step.
The largest kick (an upward dv over 0.25 m/s in a tick beyond the weight) in the last 30 ticks names the **origin**:
`hull-ghost:<kind>` (the hull pushed while more than 3 cm clear of what pushed it), `hull-protrusion:<kind>` (the hull on a surface
that stands up between wheels at their ride height), `hull-bottomed:<kind>` (on the road with a wheel on its bump stop), `crash:<kind>`
(a prop, a wall), `wheel-step` (a spring kick where a wheel's contact jumped more than 4 cm beyond the grade between two ticks),
`wheel-rebound` (a spring kick on a continuous surface), `wheel-tyre`, or `airtime` (no kick: the road fell away). The **ground** is
`seam` (a step under a wheel, a protrusion, a bottoming, or the diagnosis a step or a slab's edge: the map's business), `crest-real`
(a crest or sag in the diagnosis that the designed road, the lane's own profile, also has: v^2 k over 0.8 g on a 3 m chord, so a real
car would go light there too), `crest-bake` (a crest the physics surface has and the design does not), `crash`, or `smooth`
(everything continuous and the hull clear: a launch there is a physics bug). Where the hull touched, the top surface under the car's
footprint rises a median 0.22 m above the plane of its four wheel contacts (round four, 92 events; a 180 m design sag is 1.3 cm over
a car's length), so `seam` is the ground's shape, not the car's.

Note for anyone reading contacts in this Rapier: `numSolverContacts()` reads 0 for a moving car even in a step whose solver pushes
it, and the manifolds listed before a step are not the ones it solves. The contact force events (`ActiveEvents.CONTACT_FORCE_EVENTS`
on the hulls, an `EventQueue` passed to `world.step`) are what is reliable; the dv budget agrees with them to a few percent.

## Round one: before and after (Five Points tile, 2026-10-16)

The same audit on both. Before: the tile of 01b42b1 with the physics of the time (`--no-edge-fix`; the wheel rays then saw props
and cars too). After: this tile and this physics.

| | Before | After |
|---|---|---|
| Driven (all three speeds) | 707 km | 1155 km |
| Edges reached at 35 m/s | 585 of 7106 (the cars were wrecked) | 4555 of 6622 |
| Launches and airborne episodes | 1323 (18.7 per 10 km), in 626 places | 778 (6.7 per 10 km), in 225 places |
| of which ghost or belly hits on the ground | 695 | 60 |
| ... on decks | 192 | 57 |
| ... deck steps, edges and piers | 235 | 394 (now driven at speed: before, most of these routes ended earlier) |
| ... heightfield steps and creases | 56 | 127 |
| ... crests and sags | 42 | 104 |
| Lanes with a surface step over 4 cm | 822 | 467 |
| Jolts and kicks | 49 per 10 km | 36 per 10 km |
| Hull pushes by static collision | 19.3 per 10 km | 9.8 per 10 km |
| Lanes or turns into a building | 1 (a right turn through a corner) | 0 |
| Main roads into a building | 0 | 0 |
| Props in a lane | 64 (lamps 27, signal poles 21, trees 6, bus stops 5, bollards 5) | 0 |

Across the downtown street grid (away from the decks and the freeway) the launches are gone. `--no-edge-fix` on the new tile
gives 1319 launches over 754 km: the physics fix is most of the gain, the pipeline the rest.

## Round one: causes and fixes

- **Ghost contacts on the ground** (the cause of most launches on flat streets). The hull's speculative contacts (soft CCD
  predicts a step ahead) with the heightfield came with the normals of the edges between cells, and the solver pushed the hull up
  and back while it was 0.15 to 0.25 m clear of the road: a car at 25 m/s on a flat street lost 2.5 m/s in a tick and left the
  ground at 3 m/s. Rapier 0.21 has `HeightFieldFlags.FIX_INTERNAL_EDGES` and `TriMeshFlags.FIX_INTERNAL_EDGES`; `World.ts` builds the
  ground, and the decks, twice: a copy with the fix that only cars' hulls meet, and a plain copy for everything else (people,
  ragdolls, every ray and query, the wheel rays). With the fix for everyone, a sprinting player no longer staggered a pedestrian he
  ran into (the people's tuning), and a car bounced off a wall at a restitution of 0.34 instead of 0.15 to 0.28 (so the walls stay
  plain for cars too). `tests/ground.test.ts` pins it: a car at 30 m/s on a slope with 3 cm of noise at every vertex stays down with
  the fix and is thrown without it.
- **Wheel rays on props and cars**: a wheel's ray now sees only the world (`GROUPS.wheelQuery`); a bollard or a bench under a wheel
  was a ramp, and a hardpoint inside another car's body read as a fully compressed spring.
- **Derived bridges**: a span the design lifts over a dip is a bridge only where something passes under it (a road, a railway, a path
  2.5 m lower) or another road runs close beside it at another height; 133 of 220 are now embankments. Their decks were lifted
  6 to 10 cm over the road they continue, a step at each end.
- **Deck ends and seams**: a deck's collision top is its road surface (no drawn lift for the decks the pipeline made); an end on its
  own within 1.5 m of the ground is brought onto it, fading out over up to 20 m (6% of extra grade at most), and its corners go 3 cm
  under the ground, so the wheel rays pass from the heightmap to the deck where the two cross; where two deck pieces meet, a cap
  fills the wedge between their square ends (87 of them; 407 ends land); where decks overlap, a vertex takes the weighted mean of every deck at
  its level (within 0.6 m) whose carriageway is near it, so overlapping ribbons have one surface.
- **Piers**: none stands in a carriageway, the whole pier and not only its centre, a lower deck's included (one stood in a ramp).
- **Sidewalk slabs** beside the decks the pipeline made are not solid where they overlap a car deck (485 segments; they were a 10 to 15 cm step in it).
- **Ground creases**: 16 rounds of smoothing of the carved corridor (the vertices within 3 m of a road's edge, averaged only with
  each other, so a cut's bank does not pull the road; at most 0.1 m of change; the ground where a deck lands is left alone).
- **Roads into buildings**: buildings are cut by every lane and junction curve too, a car's half width and a little (1.3 m) either
  side, with an octagon at every bend. The one turn through a building's corner (at 11, -225) is clear.
- **Props in lanes** (the pipeline places them): lamps, trees, hydrants, bins and bollards within 1.6 m of a lane's or a turn's
  centreline are left out (101 of them), signal poles move out from the kerb until they are 1.8 m clear of every path (up to 3 m),
  and bus stops and benches in a car's path are left out (2).

Tried and dropped (each measured with this audit and the grade check): weighting the carving by the distance from each road's
paved edge, and junction planes fitted to the legs (more steep ground, no fewer launches); giving an overlapping vertex to the road
that claims it most (cliffs inside both carriageways); pins at the ends of the pipeline's bridges and landing mapped decks at the
carved ground's height (both made the ground or the deck beside them far steeper); raising the road a deck lands on when the deck
climbs fast from it (humps); smoothing with a 0.25 to 0.4 m cap (fewer launches, but over the grade check's 450 m of drivable road
steeper than 12%).

The tile is 12.05 MB (from 12.42): `collision.bin` 1.57 MB (from 1.77; 64,174 triangles from 74,530, fewer deck slabs),
`roads.glb` 2.78 MB (from 2.83), `lanes.json` 1.45 MB (from 1.55). The sim builds the ground and the deck trimesh twice: the
world builds in about 110 ms either way, and a world step with 40 cars driving takes 0.75 ms with the copies and 0.74 to 0.79 ms
without (Node, this box).

## Round two: before and after (2026-10-16)

The same audit (this code) on the tile round one left and on this one.

| | End of round one | Now |
|---|---|---|
| Driven (all three speeds) | 1155 km | 1248 km |
| Launches and airborne episodes | 778 (6.7 per 10 km) in 225 places; 186 at 15 m/s, 284 at 25, 308 at 35 | 255 (2.0 per 10 km) in 70 places; 44 at 15 m/s, 101 at 25, 110 at 35 |
| ... deck steps (deck to ground and back; deck to deck) | 327 (209; 118) | 67 (51; 16) |
| ... heightfield steps and creases | 127 | 44 |
| ... crests and sags | 143 | 28 |
| ... ghost contacts (ground; decks) | 94 (45; 49) | 76 (54; 22) |
| ... hull and wheel hits; the lane off the surface; other | 46; 29; 18 | 20; 15; 5 |
| Lanes with a surface step over 4 cm | 467 | 181 |
| Jolts and kicks | 36.3 per 10 km | 16.3 per 10 km |
| Hull pushes by static collision | 9.8 per 10 km | 3.4 per 10 km |
| Routes given up | 10.4% | 7.4% |
| Drivable road steeper than 12% | 354 m (worst 71%) | 162 m (worst 32%) |
| Lanes or turns, main roads into a building; props in a lane | 0, 0, 0 | 0, 0, 0 |

Heat maps: `.shots/ground/ground-heat-before-round2.png` and `.shots/ground/ground-heat.png`. Screenshots (the real game, the car
driven through by a bot): `.shots/ground-connector-ramps.png` (the Connector forking onto its bridges over Leonard Tate Street: 18
launches within 25 m before, none now), `.shots/ground-memorial-i20.png` (Memorial Drive over I-20: 7, none now),
`.shots/ground-overlap-connector.png` (the Connector's two carriageways 3 m apart and 4 m apart in height: 20, 15 now).

## Round two: causes and fixes

- **One design for the bridges and the roads** (`profile.ts`, `planRoads`): the mapped car bridges are solved with the ground roads,
  their nodes fitted to the height that clears what passes under them. A bridge used to be solved on its own after the roads, landing
  wherever the road it starts from happened to be and climbing as it had to (the Connector's ramps rose 2 m in 9 m, 21%, and stood
  1.8 m over Leonard Tate Street, which passes under them). Now the clearance (a car's and the slab, 6.1 m) is a constraint between
  the deck and the road it crosses, the deck climbing and the road dipping by their weights, within both grade limits; the ramps
  that fork from a motorway are held to it while they overlap; where the constraints cannot all be kept (Memorial Drive over I-20,
  the Connector, MLK Drive: bridges mapped to end a few metres past what they cross), the vertical curves near there give way to a
  180 m radius and the ties there to wishes, and the grades win. The drivable road over 12% went from 354 m to 162 m (the worst
  from 71% to 32%); on decks from 127 m to 82 m (the worst from 62% to 28%). Most of what is left on decks is short and on service roads that
  join a greater deck, whose ends now take its height (below) instead of standing on it: of a half-metre step in the greater
  carriageway and a few metres of steep ramp on the service road, the ramp is the less bad. Service roads joining a deck: 662771228 (304, 621) 28% over 21 m, 563545717 (126, 831) 23%,
  861236021 (979, 998) 20%, 1266333950 (-631, 98) 20%, 561203363 (269, 813, joining Memorial Drive) 17%; and, where a mapped deck lands
  close to what it crosses, Memorial Drive's ramp 561694953 (139, 829) 17%, Trinity Avenue 1113248252 (51, 809) 19%, 144588629
  (632, 485) 15%, 547758713 (767, -879) 14%.
- **Vertical curves**: every way's curves are at least its design speed's stopping-sight crest K and comfort sag K (radius 180 m at
  the least), and the same across the node where one way ends and the next carries on: OSM splits a road at each bridge end, and
  the kink at a ramp's foot was in nobody's curve.
- **Deck joints on the ground land**: a fork of decks at a junction (the Connector's two bridges start from one node) was a joint
  "in the air" and kept its design height, 0.3 m over the junction it starts from; now a joint within 0.6 m of the ground lands, every
  deck there alike. A landed end's corner over ground that falls away (the side of an embankment) stays at the deck's height (it was
  taken down to that ground, a metre, tilting the deck's end under the lanes).
- **Ground under the bridges the pipeline made**: the ground standing over a derived deck is now cut away as it is under a mapped
  one (the round end of the corridor carved to the road a bridge starts from reached in under the deck as it went down: a 0.3 m step
  4 m in), but only within 1.5 m of the deck (blending out over 3 m, not 2.5 and 6), never inside another road's carriageway or round
  a junction (the junction beside a deck end was dug into a trough), and never within 4.5 m of where a deck lands (its abutment: dug
  out, the heightmap cells at the end dipped into the pit, and the deck, landing on the ground it read there, followed it).
- **The weld, by height**: in a cell, two ribbons of one level that lie side by side at different heights are triangulated apart (a
  triangle spanned the 1.2 m between a ramp and the viaduct it had left, under the ramp's kerb-side wheel); two levels overlapping
  less than 2.5 m apart split the overlap at the midline instead of the lesser road losing it (its own lanes ran there).
- **A lesser deck meets a greater one's surface**: a service road's deck joining Memorial Drive's stood half a metre proud of it, 7 m
  into its carriageway (a ribbon is flat across at its own grade); now a lesser deck's vertex on a greater deck takes that deck's
  height, the greater deck's vertices are not bent by lesser ones beside them, and a lesser deck that meets a greater one at a T
  (its whole cross-section on it) stops 0.5 m inside the greater one's kerb.
- **Carving by carriageway**: a vertex counts each road as at its centre out to three quarters of its half width, so a wide
  carriageway's outer lanes follow it rather than a narrower road whose centreline is nearer (a 7-lane motorway's outer lane was
  1.5 m under the ground of a ramp beside it). Nodes more than 0.5 m off their design under a lane: 752 before, 378 now.
- **At-grade bridges**: a mapped car bridge the design keeps within 1 m of the terrain all along, with nothing under it to clear (a
  culvert, a creek the bare-earth model has filled), is a road on the ground (17): as a deck it was only seams.

Tried and dropped: carving each carriageway as at its centre right to its kerbs (277 launches against 252: sharper creases between
roads); the same for wide roads only (267 to 293); retaining the stretches of road whose carved ground is off the design (by 0.25 to
0.9 m) as slabs at the design in the collision mesh, drawn alike (the coordinator's "carriageways in the cars-only mesh": 306 to 348,
the slabs' ends and kerbs were new seams); carving the first 8 m of every deck from where it lands into the ground, outweighing the
roads around (551: it raised the ground over a road under a bridge's end); burying a deck's kerbs where the ground beside is within
0.25 m (323); capping a clearance at what the grades allow along a short way round between the deck and the road (it never bound:
the curve and tie relaxation does the job).

The tile is 12.82 MB (from 12.64): `collision.bin` 1.85 MB (from 1.57; 73,620 triangles from 64,174, of which 22,614 are the welded
deck tops of 43 levels), `roads.glb` 2.74 MB (from 2.78), `lanes.json` 1.42 MB (from 1.45). The perf budget's triangle counts are
all within budget; the one line over is desktop-medium drive.cpuP95 (3.1 ms against 3.0).

## Round three (2026-10-16)

| | End of round two | Round three, old DEM | Round three, re-registered DEM (the tile) |
|---|---|---|---|
| Driven | 1248 km | 1273 km | 1281 km |
| Launches and airborne | 255; 44 / 101 / 110 at 15 / 25 / 35 m/s | 219; 35 / 80 / 104 | 247; 36 / 99 / 112 |
| Lanes with a step over 4 cm | 181 | 138 | 123 |
| Jolts and kicks per 10 km | 16.3 | 13.3 | 12.2 |
| Hull pushes per 10 km | 3.4 | 2.9 | 2.9 |
| Drivable road steeper than 12% | 162 m (worst 32%) | 100 m (worst 39%) | 63 m (worst 26%) |

- **Lesser roads level with greater ones across their carriageways** (`junctionTies` in `profile.ts`): a side street, a service road
  or a ramp's foot that meets a greater road has its nodes over the greater road's carriageway held to its height, so it starts
  its climb at the kerb. The steep service-road joins round two left (28%, 23%, 20%, 20%, 17%) were the lesser road's design 0.7 m
  off the deck it joins 7 m in, taken up by the deck's end in one node; 662771228, 861236021 and 1266333950 are gone, 563545717
  (126, 831) is 19% over 7 m and 561203363 (269, 813, joining Memorial Drive) 17% over 6 m: both are where the design could not
  keep everything (Memorial Drive over I-20), and their ties there gave way to the grades. On the re-registered tile the decks
  steeper than 12% are 47 m in all: Capitol Avenue 563545714 (191, 831) 24% over 6 m, 547758714 (722, -848) 21%, 563545717 19%,
  561203363 17%, 755543622 (181, 894) 15%, Memorial Drive 1451206625 (124, 819) and 1447636415 (-385, -347) 12%. On the ground the same ties took the
  height conflicts out of the junctions' carving: 255 to 219 launches, 181 to 138 steps.
- **The DEM, re-registered** (`sources/dem.ts`): the M1 image was asked for with metre-square pixels, which `exportImage` does not
  give (it keeps pixels square in degrees by stretching the y extent), and was labelled with the box asked for: the terrain was
  squeezed north to south by 0.84 about the centre. Now the pixels are square in degrees, as the M2 grid's are, and the file's own
  georeferencing is used. The road network now sits on its real terrain: dips the design filled went from 2534 nodes to 576,
  bridges the pipeline made from 41 to 15, the road over 12% from 100 m to 63 m; the launches moved (219 to 247), as the residual
  places below are new ones.
- **The Highway Patrol PIT check** (`scripts/controls-check.mjs`) is pinned to the Connector northbound (337901445), where it has
  always run: round two made the southbound Connector at (781, 387) the longest straight motorway, and there the cruiser, put down at
  19 m/s on the centreline of seven lanes beside a diverging exit ramp, took its route onto the ramp at full lock, spun through
  126 degrees and rolled backwards down the bank at (708, 425). The ground there is flat across the carriageway (a probe at 1 m
  across it is level to 2 cm until 1.8 m past the kerb): it is the test's set-up, not the ground.

Measured and dropped:

- **A 2 m heightmap** (the whole tile; `groundMeshStep` 2, so the drawn ground stayed at 4 m): 291 launches as it was, 325 and 292
  with the corridor smoothing scaled to the finer grid (64 rounds, caps 0.1 and 0.2 m), against 255 at 4 m; more ghost contacts on
  the finer facets (33 to 48), crests no fewer. `height.bin` 1.0 MB to 4.0 MB, the tile 15.1 MB (over its 15 MB budget); in the sim
  (Node, the M1 tile) array buffers +5.8 MB and RSS +24 MB (274.6 to 298.9 MB: the samples in JS and in Rapier's two heightfield
  copies). `perf-budget:phone`'s heap line is the main thread's (65.4 MB at 4 m, 64.8 MB with the 2 m tile: the heightmap lives in the
  sim worker, which it does not see). The heightmap stays at 4 m; `docs/contracts/city-tiles.md` says so and keeps the format open.
- **Retaining walls** (the higher of two carriageways side by side at different heights, 1 m or more apart in height and at most
  6 m apart at the kerbs, built as a slab at its design with its sides walled down to the ground and not carved; 36 stretches): 290
  launches against 219, the slabs' ends new seams; at the Connector (690, 480) the lanes were no nearer their ground (0.65 m off before,
  1.58 m after).
- **Sides for the welded deck tops** sharing its vertices (so the internal-edge fix sees the kerb as one mesh): 270 launches against
  219 with every edge, 240 and 250 with none where the edge is within 1 m or 0.3 m of the ground; ghost contacts on decks did not
  fall (12 to 14 to 17), and the hull met the new faces (`hull-on-slab-edge` 1 to 8 to 10).
- **The car's soft CCD prediction** (1.2 m to 0.6 and 0.3), **downforce** (0) and **more suspension travel**: no change, no change and
  worse. Most "ghost" contacts on smooth roads come with no solver contact on the hull in the tick after (traced at (838, -788) on
  the Connector at 29 m/s: the push is not the hull on the ground), which the audit cannot yet tell apart; worth a look by the
  vehicles lane.

## Round four: deck barriers (2026-10-16)

Every car deck now has a solid concrete barrier along its carriageway's edges (`addBarriers` in `roads.ts`; the contract has the
rules): 15.2 km of it on the M1 tile, 0.95 m tall, vertical inner face, drawn exactly as it is solid. Before, nothing stopped a car
at a deck's edge (what read as a guardrail beside the stadium overpasses was the sidewalk deck's concrete skirt, beyond the
sidewalk): a car that left a lane went over. The same audit on the same terrain: launches 247 to 225, jolts 12.2 to 11.8 per 10 km,
hull pushes 2.92 to 2.67 per 10 km, 1 barrier contact (`hull-on-slab-edge`) in 1281 km. A car driven into the Mitchell Street
barrier at 25 degrees and 25 m/s, 45 degrees and 35 m/s, and -25 degrees and 35 m/s is turned along it, stays on the deck and
rises less than 3 m/s (`tests/ground.test.ts`). `npm run verify` checks the decks against their lanes: no lane on a deck past its
barriers, no deck more than 2.5 m a side wider than its lanes (54 deck pieces long enough to measure: 0 and 0).
`collision.bin` 1.76 to 2.21 MB (the barriers' runs are simplified where straight and level to 2 cm).

## Round four: the crash guard (the vehicles lane, 2026-10-16)

**The cause.** The "ghost" pushes on smooth roads were not the wheels. Instrumented tick by tick, the wheels' rays were continuous
(hit distances steady, normals flat, compression rates under 0.1 m/s) when a car on a flat road was thrown up by 1 to 4 m/s in one
tick and spun; the contact force events put the push on the cars-only ground or deck, along a facet's normal (about 14 degrees off
vertical), while the hull was 0.10 to 0.20 m clear of it (exact distance). Taking the hull out of contact with the static world
removed the kick (the wheels unchanged); soft CCD off moved it one tick later; hull restitution 0 took launches from 247 to 205, soft
CCD off to 169, both to 139, and soft CCD at 0.3 with restitution 0 to 206 (so round three's 1.2 to 0.6 and 0.3 changed nothing:
any prediction is enough). Soft CCD makes predictive contacts within 1.2 m; the solver treats a facet ahead of the bumper that the
hull approaches as an approach to stop, and with the crash restitution (0.32, the max rule) as one to bounce off, while the hull would
never have reached it. `FIX_INTERNAL_EDGES` only damped this.

**The fix** (`GUARD` in `src/sim/vehicles/RaycastCar.ts`, docs/physics.md): soft CCD and the crash restitution are on only in a
tick when the body's box, lifted 0.25 m clear of the road and cast along the car's motion for two steps, meets something the hull
collides with that is not a fixed face looking up (a wall, a barrier, a pole, a car, a body), and for 6 ticks after; otherwise the
hull meets the world without prediction and without bounce. The handling envelopes, the wall restitution (0.1 to 0.3), the pole at
30 m/s, the deck barrier test and the T-bone all pass unchanged.

**Before and after** (this audit; the classification above; the guard's `--no-guard` is the before):

| | Round three physics | Crash guard |
|---|---|---|
| Launches and airborne, round three's bake | 247 (39 on smooth road) | 138 (0 on smooth road) |
| Launches and airborne, the barrier bake | 225 (39 on smooth road); 37 / 85 / 103 at 15 / 25 / 35 m/s | 131 (0 on smooth road); 26 / 50 / 55 |
| ... hull pushed while clear (ghosts) | 135 | 1 (at (947, 137) on 9246950, beside a bank) |
| ... hull on a protrusion; bottomed | 14; 27 | 36; 47 |
| ... wheel kicks at a step; on a crest; airtime | 13; 4; 24 | 15; 6; 20 |
| ... by ground: seam; crest-bake; crest-real; crash | 162; 7; 9; 8 | 115; 7; 3; 6 |
| Jolts and kicks; hull pushes, per 10 km | 11.8; 2.67 | 11.1; 1.85 |
| Routes given up | 7.1% | 6.5% |

Measured on the wheel side and dropped (the wheels are not the cause): the damper's velocity capped at 3 m/s (147 launches against
138, 2 on smooth road: less damping, more bottoming); the sedan sitting higher in its travel (`restRatio` 0.95, `mountY` raised to
keep the ride height: 5 cm more bump travel, 5 cm less droop): 173, 5 on smooth road (more hull contacts on banks). The wheel kicks
left are all at steps the bake has (compression rates of 4 to 24 m/s, 10 to 40 cm in a tick) or on crests, so shape casts, normal
smoothing and sub-stepped wheel queries were not needed; the tyre's vertical push was never the kick (`wheel-tyre` 0).

**Real crests** (the design has them at the speed): Capitol Avenue's deck 563545714 at (189, 829), at 20 m/s on a 35 m/s run (the
24% climb over 6 m round three lists), and Memorial Drive's connector 547005484 at (344, 824), at 34 m/s. A real car goes light on
both. **Crests the bake makes** (7): (-742, -405) on 54032245 at 23 to 24 m/s, (392, 658) on the I-20 ramp 119686426 at 14.5 m/s,
(347, 628) on 44698161 at 18 m/s.

**Seams left** (115 events in 27 places; the map's: the ground standing up through a deck's end or beside a wide carriageway,
deck-to-ground steps): (385, 655) 18 (MLK Drive and the I-20 ramps), (704, -844) 16 and (719, -836) 5 (Pryor Street over the rail
gulch), (925, 288) 9 (the Connector's fork), (347, 629) 7, (932, 164) 7 and (944, 145) 4 (the ground rising 0.3 to 0.4 m within
the car's footprint at a wide carriageway's edge), (-562, 195) 6 (Northside Drive), (202, 811) 6 (Memorial Drive over I-20),
(-873, -263) 4, (-812, -173) 4, (-846, -163) 3, (901, -729) 3, (375, 640) 3. At (-165, -79) on 54032757 the ground stands up to
0.15 m over the deck it meets along a diagonal (round three's 15 m/s "ghost" there).

**Cost.** One box cast per moving physics car per tick (about 10 us; the car's own hull cast was 25 us, mostly the heightfield).
The sim step on the real tile with 40 traffic cars and 40 people (Node, 1800 ticks, seeds 7, 11 and 23, twice): 1.40 ms mean with the
guard, 1.37 without.

## Residuals

247 launch episodes in 63 places (1.9 per 10 km), on the re-registered DEM. By cause: deck to ground and back 49, deck to deck 14,
heightfield steps 41, ghost contacts on the ground 57 and on decks 22, crests and sags 24, hull and wheel hits 26, the lane off the
surface 11. The places with the most:

- **(385, 655), 19; (357, 634), 10** (MLK Drive and the I-20 ramps): ghost contacts and crests at a ramp's foot in steep ground.
- **(704, -844), 16; (719, -836), 5** (Pryor Street over the rail gulch): heightfield steps and deck ends landing on ground three
  roads carve to different grades.
- **(925, 289), 16** (the Downtown Connector's fork onto its bridges): deck ends landing at the junction.
- **(-562, 202), 13** (Northside Drive): a mapped deck's end on a junction carved to different heights.
- **(202, 811), 8; (270, 814), 6** (Memorial Drive over I-20): deck seams where the design could not keep its ties.
- **(-164, 922), 8** (Capitol Avenue at the gulch): ghost contacts on a deck at 25 and 35 m/s.
- **(890, 302), 8; (931, 164), 6**: the lane off the surface on wide carriageways (the lane's height is its road's centreline, the
  ground across seven lanes is not level where two corridors meet).
- **Ghost contacts on smooth roads** (57 on the ground): see above; not the ground's shape.
- **AI**: some routes are given up at 35 m/s on turns the governor takes too fast; they are counted, not hidden.
- **Service roads**: some run under a garage or a plaza (no lanes) and many dead-end at one (a garage entrance); a few streets end
  short of a building (mapped dead ends).
