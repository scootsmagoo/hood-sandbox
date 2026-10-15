# Law data (contract between the engine and city packs)

The engine owns the *rules*: crimes, witnesses, heat, search, dispatch logic. A city pack owns the *cast*: which agencies exist, where they have jurisdiction, how they pursue, and what they send at each heat level. Nothing in `src/` names an agency, a city or a road.

The design these tables serve is in the README under [Crime, heat and the police](../../README.md#crime-heat-and-the-police).

## Engine table: `src/shared/data/crimes.json`

Crimes are the same in every city.

```jsonc
{
  "crimes": {
    "carjack":      { "severity": 2, "heat": 1, "witnessRadius": 35, "points": 2 },
    "assault":      { "severity": 2, "heat": 1, "witnessRadius": 25, "points": 2, "violent": true },
    "vehicle_theft":{ "severity": 1, "heat": 1, "witnessRadius": 20, "points": 1 },  // entering an empty car that isn't yours, if seen
    "hit_ped":      { "severity": 3, "heat": 2, "witnessRadius": 40, "points": 3, "violent": true },
    "discharge":    { "severity": 1, "heat": 1, "witnessRadius": 45, "hearRadius": 130, "points": 1 },   // firing a gun in public
    "shoot_ped":    { "severity": 4, "heat": 2, "witnessRadius": 55, "hearRadius": 140, "points": 3, "violent": true },   // a bullet that hurts but does not kill (a kill is kill_ped; a shot officer is assault_officer)
    "kill_ped":     { "severity": 4, "heat": 2, "witnessRadius": 60, "points": 4, "violent": true },
    "assault_officer": { "severity": 4, "heat": 3, "witnessRadius": 60, "points": 6, "violent": true }
  },
  "rules": { /* the pacing numbers, below */ }
}
```

- `witnessRadius` is how far a witness can *see* it (with a clear line to it). `hearRadius`, when a crime has one (gunfire), is how far a witness *hears* it, with no line needed; the firing weapon's `hearM` (in `weapons.json`: a pistol 1, a shotgun 1.35, a rifle 1.45) scales it. Someone who only heard it calls it in but has no description of the culprit.
- `severity` 1–5 is compared with an agency's `minPursuitSeverity`.
- `heat` is the number of stars the crime raises the level to, at least. Heat never goes down because of a new crime. The table is checked when it loads: a crime of heat 2 or more must have a severity of 3 or more, and one of heat 3 or more must be `violent`.
- `points` and `violent` feed the escalation by accumulation (see "Pacing" below).

### Pacing: `crimes.json` "rules"

Escalation is earned, and slower than a ratchet. The numbers (tuned to GTA IV and V's feel; each is data, and `tests/pacing.test.ts` asserts the windows):

| Rule | Value | What it does |
|---|---|---|
| `callDelayS` | `[8, 20]` | a witness who calls takes this long to get through |
| `callChance` / `heardCallChance` / `victimCallChance` | 0.6 / 0.45 / 0.85 | the share of witnesses who saw it, who only heard it, and the victim that call; the rest just run (and are not asked again for `declineMemoryS`, 25 s) |
| `giveUp.lostSightS` | 5 | a caller who saw the culprit hangs up after this many seconds with no clear line to them within `sightRangeM` (70 m); those who only heard it are exempt |
| `giveUp.victimLostSightS` | 20 | the victim is slower to give up, ignores the distance and gets the call in even if they run off the map |
| `giveUp.runAwayM` | 90 | a (non-victim) caller who gets this far from the scene hangs up |
| `escalation.heat2Points` | 5 | the points of all reported crimes in a run of heat that make two stars ("repeated crimes": a carjack, an assault and a theft) |
| `escalation.heat3ViolencePoints` | 7 | the points of `violent` crimes that make three stars ("sustained violence": a kill and a hit, or two kills) |
| `reportedHoldS` / `reportedMaxHoldS` | 30 / 90 | hollow stars (reported, nobody has seen you yet) hold this long before they cool, and up to the second figure while a car is still driving to the scene |
| `cooldownS` | `[0, 20, 35, 70, 100, 125, 150]` | seconds out of sight to clear: 15 to 25 s for one star, 30 to 40 s for two, sticky above |

- **Calls.** Several calls about one crime are one report: each crime is held once by the law (`CrimeRecord`) and only the first call about it adds its heat and points; later ones come out as `crime:reported` with `duplicate: true` and change nothing. A witness already dialling takes new crimes into the same call. A caller is shown in the snapshot (`PedFlag.Dialling`, progress in `Aux2`), and stopping the call (knocking them down) is `witness:silenced`; giving up is `witness:gave-up` (`reason`: `lost-sight` or `ran-off`).
- **Heat 1 never escalates by itself**: a report gives the crime's own level and adds its points, and nothing raises it with time. A new crime, or an officer seeing one committed, does. A minor crime nobody sees creates no heat at all.
- **Heat 2** needs a crime of severity 3 or more, or the points of repeated crimes. **Heat 3 and up** needs `violent` crimes: an attack on police (`assault_officer`), or sustained violence. A single civilian kill is two stars.

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
      { "heat": 1, "maxUnits": 1, "spawnIntervalS": 40, "unitsPerSpawn": 1, "loadout": "pistol" },
      { "heat": 2, "maxUnits": 2, "spawnIntervalS": 30, "unitsPerSpawn": 1, "loadout": "pistol" }
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
| `dispatch` | where the first cars appear and how long the radio takes, by heat: `spawnMinM` and `spawnMaxM` (250 to 330 m at heat 1, 210 to 290 at 2, 160 to 240 at 3, down to 120 to 200 m at 5; out of the camera's view; a ring with no road widens inward), `delayS` (min and max seconds from a rise in the heat to a car on the road: 6 to 12 s at heat 1), and `routeFactorMax` (a spawn spot whose route to the scene is more than this times the straight line is passed over for a more direct one). So at heat 1 the first car takes about 25 to 45 s from the call to reach the scene |
| `roles` | how often roles are re-dealt, how long one is held, the most chasers and blockers |
| `pit` | the heat it starts at, the target speed window, the approach geometry, the warning time (`warnS`, the time alongside before the strike), the attempt and cooldown times, the grace after a hit, `contactSpin` (the yaw kick of the shove, rad/s) |
| `ram` | the heat it starts at (4), its range, cooldown, grace and how much faster than the target it goes |
| `roadblock` | the heat (3), the most at once by heat, the interval, the distance ahead (150 to 250 m), the number of cars (2 to 3), the chance and width of a gap, how long it stands |
| `spikes` | the heat (3), the most at once, the interval, how long a strip lies, its size and where it goes in front of a roadblock |
| `helicopter` | the heat (3), `delayS` (the air unit is scrambled 26 to 34 s after the heat first reaches its level, not at once), how many by heat, altitude (60 to 90 m), speed, orbit radius, the cone's half-angle, the range, how the cone shrinks at night, when the searchlight is on |
| `fire` | the heat (3), the reaction time, how far from a line a civilian must stand, and per loadout (`pistol`, `shotgun`, `rifle`): range, shot interval, burst length, pause, base spread; plus the spread added by range and by the target's speed |
| `cooldown` | the slowdown from heat 4 while the player is inside the search area or a helicopter is overhead |

The search area and the cooldown seconds are in `crimes.json` "rules" (`searchStartM`, `searchGrowMps`, `searchMaxM`, `cooldownS`).

A city pack's dispatch row sets the spacing: `spawnIntervalS` is the wait between one car of that agency and the next, counted from when the previous one was sent, using the row in force at the current heat. At heat 1 every agency sends **one** unit (`maxUnits: 1`); heat 2 adds a second 20 to 30 s after the first, and so on, so nothing arrives three at once at low heat. A row may also set `spawnMinM` and `spawnMaxM` to override the ring for its heat level.

### What the police ship in the snapshot

The header (`H.SearchX`, `H.SearchZ`, `H.SearchR`, `H.Roadblocks`, `H.Helicopters`, `H.Strips`, `H.Chasers`), helicopters and spike strips as entities (`EntityKind.Helicopter` and `EntityKind.SpikeStrip`; a helicopter's `Aux0` is its rotor speed, `Aux1` its height above the ground and `Aux2` the radius of the circle its cone covers), `VehicleFlag.Roadblock`, `Siren`, the flat tyres (`FlatShift`) and the role (`RoleShift`), `PedFlag.Sees`, and `PedFlag.Dialling` (a witness whose 911 call is under way, with the progress 0 to 1 in `Aux2`; the client draws a phone over their head). Events: `police:role`, `police:pit`, `police:ram`, `police:roadblock`, `police:roadblock-clear`, `police:spikes`, `police:spikes-clear`, `police:helicopter`, `police:fire` (the bullets themselves are the weapons API's `weapon:fire`) and `vehicle:tyre` for a wheel flattened by a strip (`shooterId` 0).
