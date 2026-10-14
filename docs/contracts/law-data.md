# Law data (contract between the engine and city packs)

The engine owns the *rules*: crimes, witnesses, heat, search, dispatch logic. A city pack owns the *cast*: which agencies exist, where they have jurisdiction, how they pursue, and what they send at each heat level. Nothing in `src/` names an agency, a city or a road.

The design these tables serve is in the README under [Crime, heat and the police](../../README.md#crime-heat-and-the-police).

## Engine table: `src/shared/data/crimes.json`

Crimes are the same in every city.

```jsonc
{
  "crimes": {
    "carjack":      { "severity": 2, "heat": 1, "witnessRadius": 35 },
    "assault":      { "severity": 2, "heat": 1, "witnessRadius": 25 },
    "vehicle_theft":{ "severity": 1, "heat": 1, "witnessRadius": 20 },  // entering an empty car that isn't yours, if seen
    "hit_ped":      { "severity": 3, "heat": 2, "witnessRadius": 40 },
    "kill_ped":     { "severity": 4, "heat": 3, "witnessRadius": 60 },
    "assault_officer": { "severity": 4, "heat": 3, "witnessRadius": 60 }
  }
}
```

- `severity` 1–5 is compared with an agency's `minPursuitSeverity`.
- `heat` is the number of stars the crime raises the level to, at least. Heat never goes down because of a new crime.

## City table: `data/cities/<city>/jurisdictions.json`

```jsonc
{
  "agencies": [
    {
      "id": "acp",                         // short, lowercase, unique in the pack
      "name": "Atlanta City Police",
      "short": "ACP",
      "kind": "city",                      // city | county | state | transit | state_investigations | federal | military
      "pursuit": "restrictive",            // restrictive | standard | aggressive
      "minPursuitSeverity": 3,             // below this, no vehicle chase: units respond and search on foot and by car, but break off when you flee in a car
      "pit": false,                        // whether its units use PIT maneuvers
      "livery": { "body": "#1b2a4a", "stripe": "#d8d8d8", "lightbar": ["#1e4dff", "#ff2020"] },
      "vehicle": "sedan",                  // a handling.json id; the stand-in model is recoloured with the livery
      "minHeat": 1                         // the lowest heat at which this agency joins at all (e.g. 4 for a task force)
    }
  ],
  "areas": [
    // Evaluated in order; the first match gives the primary agency at a position.
    { "agency": "ghp", "roadClasses": ["motorway", "motorway_link", "trunk", "trunk_link"], "maxDistanceM": 15 },
    { "agency": "acp", "default": true }
  ],
  "dispatch": {
    // Per agency, per heat level (1–6). Missing levels inherit the nearest lower one.
    "acp": [
      { "heat": 1, "maxUnits": 1, "spawnIntervalS": 25, "unitsPerSpawn": 1, "loadout": "pistol" },
      { "heat": 2, "maxUnits": 3, "spawnIntervalS": 15, "unitsPerSpawn": 1, "loadout": "pistol" }
    ]
  }
}
```

- `areas` with `roadClasses` match when the position is within `maxDistanceM` of a `roads.json` centreline of one of those classes. Polygon areas (`"polygon": [[x, z], ...]` in game coordinates) come later with the M3 warp, so the schema allows them, but M1 uses only road classes and the default.
- The engine picks the city pack from the tile id (`atlanta/m1-five-points` → `data/cities/atlanta/`).
