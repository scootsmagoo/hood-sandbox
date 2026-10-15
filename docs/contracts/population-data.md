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
