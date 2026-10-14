# Gameplay systems and browser multiplayer

*Research pass, 14 October 2026. Mechanics of older games come from long-standing wiki and modding knowledge. Fast-moving facts (browser support, vendors, GTA VI) were checked by web search. Items marked **[unverified]** could not be confirmed.*

## Part A: Gameplay systems

### 1. Wanted and heat systems

**GTA III, Vice City and San Andreas**
- 1–6 stars, built from crime "points".
- How the response escalates by star level:

  | Stars | Response |
  |---|---|
  | 1–2 | Patrol cops |
  | 3 | Helicopters, plus roadblocks in SA |
  | 4 | SWAT |
  | 5 | FBI |
  | 6 | The army |

- Stars decay only when no cop can see you.
- Ways to clear them: Pay 'n' Spray (only if unseen), bribe pickups (−1 star), or being busted or wasted (you lose weapons and money).
- San Andreas separates crimes the police see from crimes reported to them.

**GTA IV**
- A **search circle** around your last known position, with a radius that grows with the star level.
- Leave the circle unseen and the stars flash, then clear.
- A cop who sees you re-centers the circle.

**GTA V**
- 5 stars, and **per-officer vision cones** on the radar instead of a circle.
- When the stars flash, police search around your last known position. Staying out of every cone for a cooldown (which grows with the star level) clears you.
- How the response escalates:

  | Stars | Response |
  |---|---|
  | 1–2 | Patrol cars |
  | 3 | Helicopters, more aggressive driving |
  | 4 | NOOSE (GTA V's SWAT) |
  | 5 | More helicopters and armed units |

  Roadblocks and spike strips come at the higher levels. The army appears only inside Fort Zancudo. Exact thresholds **[unverified]**.
- Other ways to clear stars: a respray at Los Santos Customs, or the paid "remove wanted level" and "cops turn a blind eye" services in GTA Online.

**GTA V's tuning is data-driven** (the model for ours):
- `dispatch.meta`: the dispatch services (police car, police helicopter, SWAT, roadblock, boat, army), with counts and spawn timers per wanted level.
- `wantedtuning.ymt` and `dispatchtuning.ymt`: how long it takes to lose stars, and units per level.
- `loadouts.meta` and `combatbehavior.meta`: weapons and combat behavior.
- **The pattern to copy:** one table of `service × level → max units, spawn interval, model set, loadout`.
- A bug that parsed decimals wrongly in a modded tuning file caused massive overspawning, which shows how sensitive these tables are.

**GTA VI** (listed for 19 Nov 2026)
- Back to **6 stars** (Shacknews, 27 Aug 2026).
- From fan wikis, partly **[unverified]**:
  - Star states:
    - **Hollow:** crime reported, no description.
    - **Solid:** seen and pursued.
    - **Flashing:** line of sight broken.
    - **Red:** escaped, but the area is still hot.
  - **Description icons** for what the police know: face, clothing, vehicle, CCTV and companion. A haircut clears the face; sunglasses and hats don't.
  - Police respond only to crimes that witnesses report or alarms trigger.
  - You can crouch out of sight to stay hidden.

**Other games**
- **Watch Dogs**: a witness pulls out a phone, with an icon over their head. You can stop the call by smashing the phone, knocking them out, jamming the signal or hacking (WD2). Heat clears completely when you get away.
- **Mafia II**: separate wanted states for the **vehicle** (fixed by new plates or a respray) and the **person** (fixed by new clothes). Minor offenses (speeding, red lights, ramming) get a fine or bribe stop before they escalate.
- **Saints Row**: separate notoriety meters for the police and for each gang, cleared at "Forgive & Forget" shops.
- **Cyberpunk 2077 2.0**:
  - Five-star Heat, with the police units and tactics changing as it rises.
  - Dynamic blockades.
  - MaxTac, an elite squad that arrives at 5 stars as a mini-boss.
  - A GDC 2025 talk by Maciej Celmer covers **graph-based lane discovery** and **asynchronous spawn-point generation** for pursuits.

**Recommended design:**
1. A crime triggers witness perception, by sight and sound radius.
2. A witness who decides to call enters a cancellable "reporting" state lasting N seconds.
3. The police get a description: face, clothes, vehicle and plate.
4. Heat level, a last-known-position search area and a search cooldown follow.
5. Dispatch comes from the data table.
6. Clearing tools: respray, plate swap, clothes change, a "lawyer" bribe, and hiding in a safehouse or garage.

### 2. Population: pedestrians and traffic

**GTA's popcycle** (`popcycle.dat` in SA and IV)
- One set of rows per zone type (business, residential, countryside…).
- Rows cover **2-hour slots**, with separate weekday and weekend sets.
- Each row gives a maximum pedestrian count, a maximum car count, percentage scalers (dealers, gangs, cops, other) and weights over pedestrian groups.
- Popzones map areas of the world to zone types. GTA V splits this into popzones, `popgroups.ymt` and zonebind.

**Spawning**
- Keep a budget for each category.
- Spawn in a **ring** about 60–120 m out, outside the camera frustum or behind occluders: cars on lane nodes, pedestrians on navmesh or sidewalk polygons.
- Despawn things that are beyond the ring and unseen, or after a grace period off-screen.
- Never despawn anything the player has touched; flag it as persistent.

**Scenario points** (GTA V; editable in CodeWalker)
- Points that carry an activity (smoking, bench, ATM, jogging route, vendor), a time window and a model set.
- Pedestrians spawn already doing the activity, which reads as alive for little cost.

**Random events**
- GTA V has about 60 (ATM robberies, getaway drivers, hitchhikers, armored trucks) **[count approximate]**.
- Implementation: a director that picks an eligible event every few minutes by zone, time, a wanted level of 0 and cooldowns, then spawns it just out of view.

### 3. Traffic AI

**Data**
- A directed **lane graph** of nodes and links, carrying lane count, speed limit and flags (highway, no-gps, junction, shoulder). GTA V stores this in `nodes*.ynd`.
- We derive ours from OSM, plus hand fixes at the Connector, the Perimeter and Spaghetti Junction.

**Behavior**
- **Lane following**: steer toward a look-ahead target on the lane spline.
- **Car following**: the **IDM** (Intelligent Driver Model, which works from the gap ahead and a desired speed).
- **Junctions**: reservations or phase tables for signals, and queues for stop and yield signs.
- **Lane changes**: **MOBIL**-style gap acceptance (MOBIL is the matching lane-change rule).
- **Reactions to the player**: honk, brake, swerve, flee gunfire.
- **Wrecks**: wrecked or blocked cars re-path or get abandoned.

**Simulation detail by distance**

| Distance | Simulation |
|---|---|
| Near | Full rigid-body raycast car |
| Middle | Kinematic "dummy" sliding along the spline, colliding only with the player |
| Far | "Super-dummy": a single position value on a lane, or just a statistical density |

GTA IV and V are widely described as working this way **[RAGE internals unverified]**. The GDC 2022 AI Summit talk "Cities at Scale" (Sandy MacPherson, Kythera) schedules traffic flow ahead of time instead of updating every frame, which suits a CPU-limited browser.

**Police pursuit AI**
- Pursuers drive toward the predicted intercept point.
- Roles: chaser, flanker, blocker.
- Ramming and PIT (approach the rear quarter, steer into it).
- Roadblocks and spike strips spawn on lanes the player is likely to take, found by sampling the lane graph forward along their heading.
- Rubber-banding and spawn caps keep pursuits fun.
- A helicopter's spotlight cone feeds line of sight.

**Vehicle sets**
- A weighted model list per zone and time ("car groups").
- GTA SA and IV bias spawns toward the model the player is driving.

### 4. Vehicle handling

**Arcade model**
- Raycast suspension: a spring and damper for each wheel ray.
- Tire force from slip, using a simple traction curve.
- Anti-roll bars and center-of-mass tweaks.

**GTA V `handling.meta` parameters worth copying**
- Mass and weight: `fMass`, `vecCentreOfMassOffset`.
- Engine and drive: `fInitialDriveForce`, `fInitialDriveMaxFlatVel`, `fDriveBiasFront`.
- Brakes and steering: `fBrakeForce`, `fHandBrakeForce`, `fSteeringLock`.
- Grip:
  - `fTractionCurveMax` and `fTractionCurveMin`: grip at peak and when sliding, in g.
  - `fTractionCurveLateral`: slip-angle range, in degrees.
  - `fLowSpeedTractionLossMult`: burnouts.
  - `fTractionLossMult`: off-road.
- Suspension: `fSuspensionForce`, `CompDamp`, `ReboundDamp`, travel limits, `fAntiRollBarForce`.
- Damage: `fCollisionDamageMult`, `fDeformationDamageMult`, `fEngineDamageMult`.

**Handbrake drift**
- While the handbrake is held, drop the rear wheels' lateral grip toward the traction curve's minimum.
- Add a little yaw assist and counter-steer assist.

**Cheap damage**
- Pre-authored dent morph targets for front, rear, left and right, blended by impact impulse. Or vertex-shader displacement from a few stored impact points.
- Detachable panels.
- Smoke and fire driven by engine health.
- No real soft-body simulation.

### 5. On foot

- **Movement and camera**: a kinematic capsule controller with an over-the-shoulder spring-arm camera.
- **Cover**: query cover edges near the aim direction, snap to them, then peek and blind-fire.
- **Shooting**: hitscan with soft lock-on.
- **Melee**: short combos with hit reactions.
- **Carjacking**: a fixed sequence driven by the vehicle's door sockets (walk up, open, pull the driver out, get in). The victim flees or fights back depending on personality.
- **Ragdolls**: on hits, falls and vehicle impacts, then blend back to animation for a get-up. A Euphoria-style active ragdoll is out of scope.

### 6. Economy and progression (no story)

- **Money in**:
  - Street crime: muggings, stores, ATMs.
  - Car theft against export orders, like GTA Online's Import/Export or San Andreas's export cranes.
  - Heists, built from setup tasks.
  - Side jobs, and gambling.
- **Money out**:
  - Safehouses: save points that clear wanted status on entry if unseen, with a wardrobe.
  - Garages, to store and insure cars.
  - Weapons, clothes and car mods.
  - Businesses that earn passive income but get raided.
- **Progression**:
  - Stats that improve with use (San Andreas style).
  - Reputation per neighborhood or gang (like Saints Row's notoriety).
  - Rank unlocks (GTA Online).
- Keep everything server-validatable: **money is a ledger of events**.

## Part B: Browser multiplayer

### 7. Transports (Oct 2026)

- **WebSocket**
  - Supported everywhere.
  - TCP head-of-line blocking hurts at 1–2 % packet loss.
  - Fine for 8–32 players with interpolation buffers.
- **WebTransport**
  - **Baseline since 24 Mar 2026**, when Safari 26.4 shipped it. Chrome, Edge and Firefox already had it.
  - The W3C published a Candidate Recommendation snapshot on 30 Jul 2026.
  - Offers unreliable datagrams plus multiple reliable streams.
  - Older Safari and iOS versions lack it, so keep a WebSocket fallback.
  - Self-signed certificates (`serverCertificateHashes`) must be valid for at most 14 days.
  - Server options:
    - Rust `wtransport` 0.7.x (its own README says "not completely production-ready").
    - Go `webtransport-go`.
    - Node via `@fails-components/webtransport`.
- **WebRTC data channels** (geckos.io)
  - Unreliable delivery over UDP, but awkward to deploy (ICE, TURN).
  - Now mostly a legacy choice for client–server games.
- **Recommendation:** an abstract transport, using WebTransport (datagrams for state, a stream for reliable events) with a WebSocket fallback.

### 8. Architecture

**Authoritative server with client prediction and interpolation**
- The model from Valve's Source engine, Gabriel Gambetta's articles and Overwatch's GDC 2017 talk.
- Inputs go to the server as tick-stamped commands.
- The server simulates and sends back snapshots or deltas.
- Each client predicts its own player and re-simulates when the server corrects it.
- Other players are interpolated about 100 ms in the past.
- Hitscan shots are lag-compensated by rewinding the hitboxes.

**GTA Online** is widely described as **peer-to-peer with a host**, which is why it has desync, host-migration hitches and rampant cheating. The "96 players" figure for GTA VI Online is a rumor **[unverified]**. **Don't copy peer-to-peer for a browser game.**

**Vehicles**
- Rocket League runs server-authoritative physics at 120 Hz with client re-simulation, but it only has six cars in an arena.
- For a city, the pragmatic choice is that **each player's own car is client-authoritative and the server sanity-checks it**:
  - The client sends position, rotation, velocity and inputs.
  - The server checks speed, teleport distance and collision plausibility.
  - The server owns damage and money.
- Remote cars use dead reckoning plus smoothing.
- The hard case is two players' cars colliding: resolve it on the server, or have each owner apply the impulses the other sends.

**Interest management**
- A spatial grid with 64–128 m cells.
- Send rates by distance: 20 Hz near, 5 Hz in the middle distance, minimap position only when far.
- Colyseus 0.16 added `StateView` for filtering state per client.

**Ambient population**
- **Option A**: each client simulates its own deterministic, seeded population, and promotes an entity to networked when a player interacts with it.
- **Option B** (GTA Online's way): the owner of an area simulates and replicates its population, and ownership migrates.
- **Recommended: a hybrid.** Cosmetic local crowds, plus networked, server-owned significant NPCs (police, mission characters, anything a player touched).

### 9. Frameworks and hosting (Oct 2026)

| Option | Status | Fit |
|---|---|---|
| **Colyseus** (Node/TS) | 0.17 (`defineServer()`, auto-reconnect). Rooms suit 8–32 players. WebSocket and uWebSockets.js transports; WebTransport status unclear. Colyseus Cloud from $15/mo, unmetered bandwidth. | **Best fit for a TypeScript codebase** |
| **Nakama** (Heroic Labs) | Accounts, friends, matchmaking, storage, leaderboards, authoritative match loops. Active (3.21.x). | Strong for the account and social layer |
| **SpacetimeDB** 2.8 | A database with reducers, written in Rust, C#, TS or C++. | Good for persistence and MMO-style state, not for 60 Hz physics |
| **Hathora** | **Shut down game hosting on 5 May 2026** (Stormgate lost its multiplayer) | Gone |
| **Unity Multiplay** | **Deprecated 1 Apr 2026** | Gone |
| **PlayFab** | Free tier cut to 1,000 lifetime accounts in Mar 2026 (third-party reports) | Risky |
| **Rivet** | Open source (Apache 2.0), now focused on "Rivet Actors" | Usable, no longer a dedicated game host |
| **Edgegap** | About $0.0312/h for 1 vCPU + 2 GB; egress about $0.10/GB | Pay-per-use hosting |
| **Photon Fusion** | Unity only | Not applicable |
| **Custom** | Node or Bun with uWebSockets.js, or with `@fails-components/webtransport`; or Rust (tokio + `wtransport`, Lightyear 0.27, bevy_replicon) | Most control |

**Lesson: avoid lock-in to a hosting vendor.** Ship a plain container.

**Cost (order of magnitude)**
- **Compute**: about 30–60 concurrent players per vCPU, which is roughly $0.0005–0.001 per player-hour on Edgegap-class pricing, or $5–10 per vCPU per month on a Hetzner-class VPS.
- **Bandwidth**: about 10–30 kB/s per player, roughly 40–110 MB per player-hour, often the bigger cost on metered clouds.
- **So**: prefer hosts with bundled bandwidth (Hetzner, OVH, Colyseus Cloud).

### 10. Accounts, anti-cheat and persistence

- **Accounts**
  - Sign-in with OAuth (Google, Apple, Discord) or passkeys, through Nakama, Supabase or Auth.js.
  - A short-lived JWT, verified on connect.
  - Guest accounts that can be upgraded later.
- **Anti-cheat**
  - A browser client is fully inspectable, so **the server must own anything that matters**: money, inventory, damage, heat, rewards.
  - Plausibility checks on client-authoritative movement, and rate limits.
  - Hide information through interest management.
  - Detect statistical outliers.
  - Private or invite-only sessions by default.
- **Persistence**
  - Postgres (or SpacetimeDB, or Nakama storage) for profiles.
  - Money as a ledger of transactions; garages and properties.
  - Write at checkpoints, not every tick.
  - Single-player saves use the same schema, so they can migrate later.

### 11. What to design in now (single-player first)

- **Fixed-step simulation separate from presentation.** The sim never reads three.js objects, and it can run headless in Node or Bun.
- **The input-command pattern.** The controller reads `{tick, buttons, analog, aim}` commands, never raw keys.
- **Stable entity IDs and serializable component state.** Everything spawns through one registry with an `authority`/`owner` field.
- **Event-sourced game rules.** Crimes, damage, money and heat are events handled by one rules module.
- **A seeded RNG for each subsystem.** Seed the ambient population by (cell, time slot).
- **Cosmetic and significant populations** kept separate from day one.
- **Data tables in JSON** (handling, dispatch, popcycle, vehicle groups, scenario points), shared by client and server.
- **No lockstep determinism.** Floats and Rapier across browsers make it hard, so use snapshot interpolation and client-authoritative own vehicles instead.
- **A transport interface with a loopback implementation now**, so latency and packet loss can be injected in tests.

## Sources

- WebTransport: https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready, https://developer.mozilla.org/docs/Web/API/WebTransport, https://www.w3.org/standards/history/webtransport/
- https://docs.rs/crate/wtransport/latest; https://docs.rs/crate/lightyear/0.27.0
- Hathora shutdown: https://www.techspot.com/news/111969-stormgate-servers-go-dark-following-ai-focused-hosting.html, https://docs.edgegap.com/docs/tools-and-integrations/switch-from-hathora
- https://status.unity.com/info_notices/362941
- https://accelbyte.io/blog/playfab-just-cut-its-free-tier-by-99.-heres-what-that-means-for-your-game
- https://edgegap.com/pricing; https://www.colyseus.io/pricing; https://colyseus.io/blog/colyseus-017-is-here/
- https://heroiclabs.com/blog/oct-2025-newsletter/; https://spacetimedb.com/changelog/v2.8.0; https://www.rivet.dev/blog/
- GTA VI: https://www.shacknews.com/article/150518/grand-theft-auto-6-wanted-level-system, https://www.gtabase.com/articles/gta-6/gta-6-wanted-level-explained-police-system-guide
- Cyberpunk police: https://cyberpunk.net/en/news/48766/whats-coming-in-update-2-0-revamped-police, https://gdcvault.com/play/1035509/Heat-MaxTac-and-Blockades-Expanding
- Cities at Scale: https://gdcvault.com/play/1027576/AI-Summit-Cities-at-Scale
- Watch Dogs: https://watchdogs.fandom.com/wiki/Heat_Level_in_Watch_Dogs_2
- GTA modding: https://www.gta5-mods.com/misc/realistic-dispatch-mod-modified-crime-and-police-rebalance-mod, https://www.gta5-mods.com/tools/codewalker-gtav-interactive-3d-map, https://gtacars.net/gta5/glossary
- Classic netcode references: Gaffer On Games "Networked Physics"; Gabriel Gambetta "Fast-Paced Multiplayer"; Valve "Source Multiplayer Networking"; GDC 2017 "Overwatch Gameplay Architecture and Netcode"; GDC 2018 "It IS Rocket Science!"
