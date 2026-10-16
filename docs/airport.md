# Hartsfield-Jackson Atlanta International Airport

The airport is its own grid of tiles (`city.json` grid `airport`, `public/tiles/atlanta/airport/`) until the M3 warp places it in
the city: open it with **`?spawn=airport`** (the same as `?tiles=tiles/atlanta/airport/`). You start at the curb of the Domestic
Terminal with a car beside you.

## What is there

- **The field.** All five parallel runways (8L/26R, 8R/26L, 9L/27R, 9R/27L and 10/28, which crosses I-285: the freeway runs in its
  cut under the runway's deck), every taxiway and taxilane, the aprons and ramps, the stopways and blast pads, from the OSM
  `aeroway` layer. Concrete slabs, asphalt shoulders, rubber in the touchdown zones; painted threshold bars, designators,
  centrelines, aiming points, touchdown zone bars and side stripes; yellow taxiway centrelines, runway holding positions (two solid
  and two dashed lines; ILS holds as a ladder), the stands' lead-in lines and stop bars, stopway chevrons. At night: runway edge,
  centreline, touchdown zone, threshold (green) and end (red) lights, the approach lights with their sequenced flashers, green
  taxiway centreline and blue edge lights, floodlight masts round the aprons. Mown grass inside the aerodrome.
- **The buildings** (script-built heroes, `tools/blender/airport/`): the Domestic Terminal (the North and South Terminals round the
  glass-roofed Atrium, curbs under deep canopies), Concourses T and A to F with a jet bridge at every gate, the Maynard H. Jackson
  Jr. International Terminal, Atlanta Tower (121 m), the North and South Hourly and Daily parking decks, the ATL West Parking Deck,
  the Rental Car Center and the ATL SkyTrain to the Gateway Center. The generic buildings round them come from Overture as
  everywhere (the cargo buildings, the hangars, College Park).
- **Inside.** You can walk into the Domestic Terminal through its six north doors: the ticketing hall (check-in islands, kiosks,
  queue lines), baggage claim (four carousels), the Atrium (food court, the departures wall, planters), the security checkpoint
  (eight lanes of belts and arch scanners) and on into Concourse T: its corridor the whole length, the holdrooms of gates T1 to
  T21 with their seats, gate desks and screens, and windows onto the apron and the aircraft at the gates; shops and restaurants
  along the corridor. Travellers walk through it and sit at the gates (scenario points), and the street label names the place
  (Ticketing, Baggage Claim, Atrium, Security Checkpoint, Plane Train, Gate T5 ...). The Plane Train's escalators are drawn but not
  walkable, and the South Terminal is closed.
- **Aircraft** (AI only, `src/sim/aircraft`): see below.

## Names

Real names for the airport and its parts. Airlines are parodies (`data/cities/atlanta/brands.json`, `src/shared/data/aircraft.json`
`liveries`: Peachtree Air Lines, Peachtree Connection, Sunbelt Airways, Americano Airlines, Untied Airlines, Ghostly Air, Outpost
Air, Albion Airways, Royal Tulip, QuickShip Cargo, Brownline Cargo); the aircraft carry colours only, no lettering, and every sign
in the terminal is a blank coloured panel.

## Air traffic

- **Schedule** (`AirTraffic.ts`). West flow, as Hartsfield-Jackson flies most days: arrivals land on the outer runways (26R for the
  stands north of the terminal, 27L and 28 by turns for the south ones), departures take the inner ones (26L, 27R). An arrival is
  due every 38 to 62 s; each is given a free stand of its class (a narrowbody, a regional at the T, C and D gates, a widebody at
  E and F, a freighter at the cargo ramps), parks for 6 to 16 minutes, then departs. At the start a little over half the 235
  stands are taken, and the schedule has already run for 15 minutes, so aircraft are moving at once.
- **Plans** (`plans.ts`). A flight is planned whole when it is due: an arrival from 14 km out down a 3 degree glide path, a flare,
  the touchdown 380 m past the threshold, the rollout and the first taxiway it can take beyond its class's roll (1.2 to 1.9 km),
  then the taxi graph (A* over `aeroway.json`'s taxiways and taxilanes, never along a runway, corners rounded to the class's turn
  radius) to its stand's lead-in and the stop mark. A departure: a pushback by a tug (nose away from the way it moves) off the
  stand and onto the taxilane the other way from where it will go, a pause for the tug, the taxi out, a hold short of the runway,
  line up and wait, the roll, rotation and a straight climb out to 16 km. Speeds and accelerations by class (`aircraft.json`).
- **Separation.** Each new plan is checked against every flight planned before it, sampled every 2 s: no two on or near the ground
  closer than their half spans and 8 m, no two arrivals on one runway within 90 s, no two departures within 60 s, and its stand
  clear when it arrives. Where there is a conflict it is delayed in 4 s steps (an arrival holds out of sight, a departure stays at
  its gate). Plans never change once made and are made in time order: the same seed gives the same traffic
  (`tests/airport/airTraffic.test.ts`).
- **Physics.** Kinematic. Within 450 m of the player an aircraft on or near the ground has a body of boxes (`aircraft.json`
  `colliders`: fuselage, wings, engines, tail, gear), kinematic when it moves and fixed when it is parked: cars bump into it, the
  player walks into it, an aircraft taxiing over the player knocks them down.
- **On the wire.** The snapshot's aircraft block (`src/shared/snapshot.ts`): the moving aircraft as records (pose, speed, gear,
  thrust, phase and light flags), the parked ones as one word per stand. The client interpolates the records by id.
- **Drawn** (`src/client/render/aircraft/`). Three classes (`ac-narrowbody`, `ac-widebody`, `ac-regional`: A320, 777 and CRJ900
  classes, built from `aircraft.json` by `tools/blender/airport/aircraft.py`) at three levels of detail (to 220 m, to 1.1 km,
  beyond), instanced per class, level and material, with the livery per instance (six colours; the paint's vertex colour says the
  region). Gear down or up, nav, tail, beacon, strobe and landing lights (sprites, at every distance), cabin windows lit at night, a
  tug at the nose during a pushback, a belt loader and a baggage train beside the parked aircraft near the camera.

## Flyable aircraft later

What is kept apart for it (`src/sim/aircraft/control.ts`): an aircraft's state (`AircraftState`: what the snapshot writes, the
bodies follow and the client draws) is moved by a `Controller`. The AI's `AiPlanController` evaluates its plan; a player's would read
`FlightControls` from the input and integrate a `FlightModel` (`integrate(state, controls, dt, ground)`: lift, drag, thrust,
gravity, the gear on the ground). Still to build: the way in (a parked aircraft's `anchor_doorL1`, the jet bridge or stairs), a
`PlayerFlightController` that takes the aircraft out of its stand or plan as a car is taken from traffic, the flight model and its
ground contact on the heightmap and the runways, the aircraft as the snapshot's controlled entity and a camera for it, a dynamic
body (or a kinematic one moved by the model), and the AI treating a player's aircraft as an obstacle it does not plan round (they
keep their schedule). Helicopters would reuse the same split (the police helicopter is already a kinematic flyer).

## The rail station

The MARTA Airport station is inside the Domestic Terminal's west end. The terminal leaves the room for it open (12 m tall, its
west face open), and its sidecar names it: `hooks.transitStation = { x: -5231.45, z: 12583.9, yaw: 0, length: 76.4, width: 46.6,
floorY: 0 }` (world x, z; the floor is the terminal's, 310.52 m). The rail layer's Red and Gold lines can end there; the hall's
walk network reaches the room through its door node at its west face (model (-159.5, 0)).

## How it is made

- Data: one Overpass request for the `aeroway` layer, five for the tiles' own queries (merged over the 28 tiles), 3DEP per tile and
  Overture once (city-tiles.md section 16); the airport's buildings' outlines, gates, stands and jet bridges in
  `tools/blender/airport/airport.json` (`footprints.ts`).
- Bake: `world/aeroway.ts` (the model), `aerowaySurface.ts` (ground, pavement, paint), `aerowayBake.ts` (the tile bake's steps),
  `aerowayGraph.ts` (`aeroway.json`), `aerowayFetch.ts` (the extract).
- Checks: `tests/airport/` (the traffic's separation and determinism; spawn, walking into the terminal and an aircraft landing and
  parking in the real sim), `tests/airportAircraft.test.ts` and `tests/airportHeroes.test.ts` (the models), `tools/pipeline/test/
  aeroway.test.ts`, `npm run check:controls -- --only airport` (the same in the browser with real keys), `npm run leaks -- --phases
  aircraft`, `node scripts/airport-shots.mjs` (.shots/airport-*.png).

## Known gaps

- The interiors are one level (the real ticketing and baggage claim are on two); the jet bridges meet the concourse facade 3.4 m
  up, and a panel at each gate door hides it from inside. The South Terminal and the other concourses are not walk-in.
- The streets that pass under the parking decks run through the decks' ground level (the decks' hulls are cut by their lanes).
- One flow (west); no go-arounds, no runway crossings planned on purpose (a crossing happens where a taxi route crosses a runway,
  and the separation check delays the flight), no cargo-only schedule.
