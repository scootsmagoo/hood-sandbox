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
    "discharge":    { "severity": 1, "heat": 1, "witnessRadius": 45, "hearRadius": 130 },   // firing a gun in public
    "shoot_ped":    { "severity": 4, "heat": 2, "witnessRadius": 55, "hearRadius": 140 },   // a bullet that hurts but does not kill (a kill is kill_ped; a shot officer is assault_officer)
    "kill_ped":     { "severity": 4, "heat": 3, "witnessRadius": 60 },
    "assault_officer": { "severity": 4, "heat": 3, "witnessRadius": 60 }
  }
}
```

- `witnessRadius` is how far a witness can *see* it (with a clear line to it). `hearRadius`, when a crime has one (gunfire), is how far a witness *hears* it, with no line needed; the firing weapon's `hearM` (in `weapons.json`: a pistol 1, a shotgun 1.35, a rifle 1.45) scales it. Someone who only heard it calls it in but has no description of the culprit.
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
      "minHeat": 1,                        // the lowest heat at which this agency joins at all (e.g. 4 for a task force)
      "unmarked": false,                   // optional: plain cars, no stripe or lightbar; the strobes and the siren come on only while the unit is chasing
      "strobe": ["#ff2a2a", "#2a5cff"]     // optional (unmarked only): the two strobe colours
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

## Engine table: `src/shared/data/police.json` (escalation rules)

What each heat level adds on top of the pack's dispatch rows. Arrays are indexed by heat level 0 to 6 (index 0 unused). Nothing in it names a city.

| Block | What it sets |
|---|---|
| `roles` | how often roles are re-dealt, how long one is held, the most chasers and blockers |
| `pit` | the heat it starts at, the target speed window, the approach geometry, the warning time (`warnS`, the time alongside before the strike), the attempt and cooldown times, the grace after a hit, `contactSpin` (the yaw kick of the shove, rad/s) |
| `ram` | the heat it starts at (4), its range, cooldown, grace and how much faster than the target it goes |
| `roadblock` | the heat (3), the most at once by heat, the interval, the distance ahead (150 to 250 m), the number of cars (2 to 3), the chance and width of a gap, how long it stands |
| `spikes` | the heat (3), the most at once, the interval, how long a strip lies, its size and where it goes in front of a roadblock |
| `helicopter` | the heat (3), how many by heat, altitude (60 to 90 m), speed, orbit radius, the cone's half-angle, the range, how the cone shrinks at night, when the searchlight is on |
| `fire` | the heat (3), the reaction time, how far from a line a civilian must stand, and per loadout (`pistol`, `shotgun`, `rifle`): range, shot interval, burst length, pause, base spread; plus the spread added by range and by the target's speed |
| `cooldown` | the slowdown from heat 4 while the player is inside the search area or a helicopter is overhead |

The search area and the cooldown seconds are in `crimes.json` "rules" (`searchStartM`, `searchGrowMps`, `searchMaxM`, `cooldownS`).

### What the police ship in the snapshot

The header (`H.SearchX`, `H.SearchZ`, `H.SearchR`, `H.Roadblocks`, `H.Helicopters`, `H.Strips`, `H.Chasers`), helicopters and spike strips as entities (`EntityKind.Helicopter` and `EntityKind.SpikeStrip`; a helicopter's `Aux0` is its rotor speed, `Aux1` its height above the ground and `Aux2` the radius of the circle its cone covers), `VehicleFlag.Roadblock`, `Siren`, the flat tyres (`FlatShift`) and the role (`RoleShift`), and `PedFlag.Sees`. Events: `police:role`, `police:pit`, `police:ram`, `police:roadblock`, `police:roadblock-clear`, `police:spikes`, `police:spikes-clear`, `police:helicopter`, `police:fire` (the bullets themselves are the weapons API's `weapon:fire`) and `vehicle:tyre` for a wheel flattened by a strip (`shooterId` 0).
