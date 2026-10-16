# Population data (contract between the engine and city packs)

The engine owns the *rules* of the ambient city: the spawn ring, budgets, behaviours, traffic driving and reactions. A city pack owns the *mix*: which zones exist, how busy each one is at each time of day, and which kinds of people and cars fill it. Nothing in `src/` names a city, a district or a street.

The design is in the README under [Pedestrians and the ambient city](../../README.md#pedestrians-and-the-ambient-city) and [Traffic](../../README.md#traffic). It's modelled on GTA's `popcycle`.

## Time

- The sim has a deterministic game clock, `sim.clock` (`src/sim/clock.ts`). It holds `minutes` since midnight, `day` (0 = Monday … 6 = Sunday), `slot` (0–11, two-hour slots starting at midnight) and `weekend` (Saturday and Sunday).
- The snapshot carries the clock in header words `H.ClockMinutes` (f32) and `H.Day` (u32).

## City table: `data/cities/<city>/population.json`

```jsonc
{
  "pedGroups": {
    // Kinds of pedestrians. `outfits` index the client's outfit table (1..OUTFIT_COUNT-1; 0 is the protagonist).
    "business":  { "outfits": [1, 2], "walkSpeed": [1.2, 1.5], "behaviour": { "wander": 0.7, "scenario": 0.3 } },
    "tourists":  { "outfits": [3, 4], "walkSpeed": [0.9, 1.2], "behaviour": { "wander": 0.5, "scenario": 0.5 } }
  },
  "vehicleGroups": {
    // Kinds of traffic. `type` is a handling.json id; paints are optional hex colours.
    "city":  [ { "type": "sedan", "weight": 6 }, { "type": "coupe", "weight": 2 }, { "type": "pickup", "weight": 1 } ],
    "night": [ { "type": "coupe", "weight": 3, "paints": ["#101010", "#f0f0f0"] }, { "type": "sedan", "weight": 2 } ]
  },
  "freeway": {                              // optional: the motorways and trunk roads (below); a pack without it gets the engine's default
    "weekday": [ /* 12 slots */ { "cars": 20, "speed": 0.8, "vehicleGroups": { "city": 1 } } ],
    "weekend": [ /* 12 slots */ ]
  },
  "zones": [
    {
      "id": "core",
      "name": "Downtown core",
      "kind": "business",                 // business | park | venue | transit | residential | industrial | nightlife
      "polygon": [[x, z], ...],           // game coordinates of the tile; leave out for the default zone
      "default": false,                   // exactly one zone is the default: it covers wherever no polygon does
      "weekday": [ /* 12 slots, 00:00–02:00 first */ { "peds": 4, "cars": 10, "pedGroups": { "business": 0.7, "tourists": 0.3 }, "vehicleGroups": { "city": 1 } } ],
      "weekend": [ /* 12 slots */ ]
    }
  ]
}
```

### Units and rules

- `peds` is the target number of ambient pedestrians per **100 m of sidewalk** inside the spawn ring.
- `cars` is the target number of moving ambient cars per **1 km of driving lane** inside the spawn ring.
- `pedGroups` and `vehicleGroups` inside a slot are weights. They don't have to add up to 1.
- Zones are tested in order, and the first polygon that contains the point wins. If none does, the default zone applies.
- The engine scales every budget by the graphics tier's density and by a hard cap on entities (`MAX_ENTITIES` in `src/shared/snapshot.ts`, currently 256 for everything, including the player, police and parked cars).

The engine picks the city pack from the tile id (`atlanta/m1-five-points` → `data/cities/atlanta/`), the same way it picks the law data. Missing file → a generic default population in `src/shared/data/`.

## How pedestrians read it (`src/sim/peds/`)

- The director looks at the cells (32 m) round the player. A cell's wish is `its sidewalk length / 100 x slot.peds`, weighted toward the player (3.2x inside 45 m, 1.2x to 75 m, 0.35x to 105 m, 0.1x beyond, so the busy part is the part you can see). If the wishes add up to more than the budget (60 on High, 40 on Medium, 24 on Low, `pedBudget`; never more than the free entity slots minus 28) every cell's wish is scaled down together. `peds: 0` in every slot of a zone means nobody there at that hour.
- A person is made in a cell that has fewer people than it wishes, about 40 to 120 m from the player and where the camera cannot see (outside its cone, or behind a wall). The first fill, before the first frame, may use the whole ring from 14 m.
- The slot's `pedGroups` weights pick the group. The group's `behaviour` weights pick *wander* (a walker on a sidewalk) or *scenario* (already doing something at a scenario point in that cell; if there is none free, a walker). `outfits` is a list of outfit indices to pick from, `walkSpeed` the range of the person's pace in m/s.
- The zone `kind` biases the scenarios: `park` favours lawns and benches, `transit` bus stops, `venue` plazas and eateries, `nightlife` eateries and corners, `business` ATMs.
- The time is `sim.clock`: `slot` and `weekend` choose the row. The population follows the clock: when the table asks for fewer people the farthest unseen ones leave first, and those in view stay until they walk out of it.
- Anyone the player touched (hit, carjacked, a witness the law is waiting on a call from, someone who fights back) is never removed while the camera could see them, and not at all within 170 m.

## How traffic reads it (`src/sim/traffic/`)

- Every sample point along the main lanes (one per 20 m) within 230 m of the player counts `slot.cars x lane length / 1000` toward the number of cars wanted, where `slot` is the one of the zone at that point, picked with `sim.clock` (slot and weekend). Lanes are weighted by road class (primary 1.7, secondary 1.5, tertiary 1, residential 0.55, unclassified 0.7, ramps 0.6 of their street class) because `cars` is "per km of driving lane" and the avenues carry the traffic. The sum is scaled by the tier's density (High 1, Medium 0.75, Low 0.5) and capped at 40 cars on High (`TRAFFIC.cap`), and nothing spawns while the registry is within 40 entities of the 256-entity snapshot.
- A car is made 120 to 230 m from the player, out of the camera's view when it is closer than 200 m, on a lane with 16 m of room; the chance of a spot is `slot.cars x road weight` over the busiest zone's value, a little higher nearer the player. The first fill may use 60 m and up.
- The slot's `vehicleGroups` weights pick the group, the group's weights the type (a `handling.json` id), and `paints` (hex) its colour, else the stand-in palette.
- Cars are removed once they are farther than 320 m and out of the camera's view, or farther than 450 m; the table asking for fewer cars never removes one, it only stops new ones.

### Freeways (`src/sim/traffic/`)

A motorway or trunk lane (and a ramp: 0.7 of it) is not in the zone rows. Freeways do not loop inside a tile, so they are not in the main component; they are *through routes* (`LaneGraph.flow`): a lane that starts at the edge of the loaded area is a **source** (a car is put at its start now and then, as often as the row says cars pass a point), a lane that ends at it is a **sink** (a car that reaches its end is removed; a physics car near it is handed back to a spline follower first). The edge of the loaded area is the tile's bounds in a single-tile world and the union of the loaded tiles in a streamed one: a lane that ends at a seam to a loaded neighbour is neither, and streaming moves the sources and sinks with the tiles.

- `freeway.weekday` / `freeway.weekend`: 12 slots of `{ cars, speed, vehicleGroups? }`. `cars` is per km of motorway or trunk lane within 200 m of the player; `speed` is the share of the free flow the traffic runs at (1 free, 0.5 a crawl); the group weights fall back to the zone's. The slots are read as the level at their middle and blended between, so the rush hour builds and eases off instead of stepping at a slot edge (`freewayAt`).
- Free flow is 1.25 times the posted limit on the straights (a 55 mph limit runs about 65 mph), never over about 70 mph, and a bend runs at what the lane allows. A connector straight across a node of a freeway is as fast as the lanes it joins.
- The freeway has its own cap, apart from the avenues': `TRAFFIC.freewayCap` (88 on High) times the tier's density squared (Low has a quarter of it) times how busy the row says the hour is (`cars` over 32, never under 0.3). The cars are spline followers except the few near the player, so they are cheap. Spawn ring 70 to 200 m, nearer spots likelier, removal beyond 250 m when unseen (380 m always), at least 38 m of room on the lane. Most of the cars drive past exits (the connector onto a ramp is 0.35 as likely as straight on).
