# Hood Sandbox

[![CI](https://github.com/scootsmagoo/hood-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/scootsmagoo/hood-sandbox/actions/workflows/ci.yml)

**A GTA-style open-world crime sandbox built from real cities, running in the web browser. The first city is metro Atlanta: Intown, Cobb, Gwinnett and the suburbs between them.**

The engine is city-agnostic. Everything that makes the game *Atlanta* (the map data, districts, police agencies, crews, parody brands and landmarks) lives in a **city pack**, so other cities can be added later with the same rules. See [City packs](#city-packs).

There is no story yet, and that's deliberate. The game is the city: real streets and highways, real neighborhoods, pedestrians and traffic going about their day, side hustles on every corner, and a police response that feels like Atlanta's. A minor offense on a city street won't start a chase. Do the same on I-285 and the State Patrol will PIT you at 110 mph.

> **Status: M1 spike playable (14 October 2026).** You can walk and drive a real 2 × 2 km tile of Downtown around Five Points, carjack the car at the curb, and steal the parked ones. `npm install && npm run dev`, then open http://127.0.0.1:5180. M1 is done once it has been checked on a real Mac and iPhone ([docs/perf.md](docs/perf.md)).
>
> This README is the plan: what we're building, what it's built with, and the order we'll build it in. The research behind it is in [`docs/research/`](docs/research/). The cast (the protagonist, the crews and the police agencies) is drafted in [`docs/CAST.md`](docs/CAST.md) and waiting for review.

---

## Contents

- [Pillars](#pillars)
- [Decisions so far](#decisions-so-far)
- [The map](#the-map)
- [Gameplay](#gameplay)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [City packs](#city-packs)
- [The world pipeline](#the-world-pipeline)
- [Performance and devices](#performance-and-devices)
- [Multiplayer (later)](#multiplayer-later) (and [Hosting on Cloudflare](#hosting-on-cloudflare))
- [Names, brands and data licenses](#names-brands-and-data-licenses)
- [Roadmap](#roadmap)
- [Open questions](#open-questions)
- [Planned repo layout](#planned-repo-layout)
- [Research](#research)
- [License](#license)

---

## Pillars

1. **A real place.** The layout of Atlanta and its north suburbs is generated from real map data, so locals can find their own exit, their own Waffle House (under a parody name) and their own shortcut. It's compressed the way GTA V compressed Los Angeles, but the order of things stays right.
2. **Crime and the chase are the core loop.** Witnesses call it in. Police search where you were last seen. How hard they chase depends on whose jurisdiction you're in. You get away by breaking line of sight, changing your car, your plates or your clothes, or by reaching a safehouse.
3. **A city that lives without you.** Traffic on a real lane graph, pedestrians doing things (not just walking), and the time of day, the weather and game days at the stadium all change who's out and where.
4. **Side activities instead of a story.** Rideshare runs, tow and repo jobs, street takeovers, I-285 night races, EMS shifts, chop-shop export lists, and so on.
5. **It runs in a browser.** That means desktop, gamepad and phone, with one click to play and no install. It should hold 60 fps on an M-series MacBook and stay playable on an iPhone.
6. **Multiplayer-ready, single-player first.** The simulation is built so a server can run it later (GTA Online-style sessions), but single-player comes first.
7. **One engine, many cities.** Nothing in the engine names Atlanta. A city is data plus hand-built hero assets.

## Decisions so far

| Topic | Decision |
|---|---|
| Map scale | **Compressed, faithful layout.** Real geography is warped into a game map of roughly 100–150 km², about 1.3–1.9× GTA V. Intown is squeezed less than the suburbs. See [The map](#the-map). |
| Map edges | **Hartsfield-Jackson** (south), **Stone Mountain** (east), **Lake Lanier** (northeast) and **Lake Allatoona** (northwest) are all on the map. |
| First playable area | **Downtown, Midtown, the Connector, Little Five Points, Candler Park, Buckhead and Vinings** (the [M2 slice](#roadmap)). |
| Era | **Present day (2026).** GA-400's express lanes under construction, Centennial Yards rising over the Gulch, the BeltLine, the city just past the World Cup. |
| Protagonist | **One fixed protagonist** for now. The draft is Keon "Kudzu" Mabry, a laid-off tow-truck driver ([CAST.md](docs/CAST.md)). A character creator comes later. The world comes first. |
| Shooting vs driving | **Equal priority.** The M2 slice needs both to feel good. |
| Gangs | **Fictional gangs with turf.** Six crews are drafted in [CAST.md](docs/CAST.md). See [Gangs](#gangs-fictional). |
| Sensitive sites | **On the map and treated respectfully**, never played for laughs. |
| Music | **No licensed music, and no Spotify or Apple Music.** The radio plays the player's own files plus house stations. Low priority (M4). See [Radio](#radio-bring-your-own-music). |
| Names | **Real everything that's legally safe; parody only what's trademarked** (owner, 16 Oct 2026). Geography, streets, neighbourhoods, government buildings, public parks, churches and universities keep their real names, and landmark buildings keep their real shapes, colours and heights. Brand and corporate names (stadium and arena sponsors, Coca-Cola, banks, hotels, private developments such as Atlantic Station, and the word "Olympic") get GTA-style parodies (`data/cities/atlanta/brands.json`, `displayName` in `landmarks.json`). No logos, wordmarks or brand signage on any model. Police and other agencies keep fictional names that echo the real ones. Get a legal review before any commercial release. |
| Look | **Stylized-realistic.** GTA-like proportions, procedural and CC0 textures, simplified detail. |
| Rating | **M (GTA-level).** Violence, blood, swearing and crime as the core loop. Sexual content stays off-screen. Gore and language get settings toggles. |
| Devices | **Desktop browsers, gamepads and phones/tablets.** |
| Multiplayer | **Single-player first, with multiplayer-ready code.** |
| Client tech | **TypeScript + Vite + three.js (WebGL2 renderer, WebGPU later) + Rapier (WASM physics)**, with the simulation in a Web Worker. Rust compiled to WASM only for hot paths that profiling identifies. See [Tech stack](#tech-stack). |
| Title | **Hood Sandbox.** It names the engine, so it works for any city. Each city gets its own subtitle later. |
| Hosting | **Cloudflare** (the account already has **Workers Paid + R2 Paid**): the game as Workers static assets (with COOP/COEP headers), map tiles in **R2** (no egress fees), and later one **Durable Object per multiplayer room**. See [Hosting on Cloudflare](#hosting-on-cloudflare). |
| License | **MIT** for the code. The map data keeps its own licenses ([details](#names-brands-and-data-licenses)). |

---

## The map

### Area

| Area | Land area |
|---|---|
| City of Atlanta | ~350 km² (135 mi²) |
| Cobb County | ~880 km² (340 mi²) |
| Gwinnett County | ~1,116 km² (431 mi²) |
| North Fulton (Sandy Springs, Roswell, Alpharetta, Johns Creek) | ~450 km² |
| North DeKalb (Brookhaven, Dunwoody, Chamblee, Doraville, Tucker) | ~125 km² |
| Edges: south Fulton to the airport (East Point, College Park, Hapeville), Stone Mountain Park, the near shores of Lake Lanier and Lake Allatoona | ~400 km² more |
| **Total** | **~3,300 km²** (bounding box ~67 × 89 km, from about 33.62°N to 34.22°N and 84.78°W to 83.82°W) |

That's about 40 times GTA V's map (~80 km²). Built 1:1, driving from Austell to Buford would take most of an hour and pass through thousands of identical cul-de-sacs. So we compress the map.

### Compression

We don't scale the map down uniformly. Shrinking it would make lanes, buildings and people tiny. Instead:

1. **Warp positions, not objects.** A fixed set of control points (landmarks, interchanges, town squares) maps real coordinates to game coordinates. Everything between them is interpolated. People, cars, doors, lanes and buildings stay at 1:1 scale.
2. **Vary the compression by area.**
   - **Intown core** (Downtown, Midtown, Buckhead, Old Fourth Ward, West End, East Atlanta): about **1:2**. Dense, walkable, where most of the play happens.
   - **Suburban centers** (Marietta Square, Cumberland/The Battery, Perimeter, Duluth, Lawrenceville, Buford): about **1:4–1:5**. Recognizable town centers.
   - **Suburban fill and exurbs**: about **1:7–1:8**. Representative subdivisions, strip malls and woods.
   - **The edges** (the airport, Stone Mountain Park, Lake Lanier and Lake Allatoona): the setting around them is compressed hard, but the place itself stays near real size. A runway, the granite dome or a lake you can race boats on only works at full size. The lakes keep their nearest arms and shores, and their far reaches fade into the map edge.
3. **Thin the street network by class.** Interstates, highways and arterials are always kept. Local streets are kept in the core and sampled in the suburbs, chosen so blocks still read as real.
4. **Set travel-time targets** (to tune later): Downtown to Midtown in about 1 minute of city driving, Downtown to Marietta Square in about 2–3 minutes on I-75, a full lap of I-285 in about 6–8 minutes.

With these factors the game world comes out at about 18 × 22 km. At that size float32 precision is fine (about 2 mm at worst). We'll still render camera-relative and keep physics around a local origin, so the map can grow later.

### Districts (first pass)

**Intown Atlanta**
- **Downtown**: towers, the Capitol, stadium and arena, Centennial Park, Five Points, Underground. Busy on game days, empty at night.
- **Midtown**: high-rises, Piedmont Park, the Fox, Georgia Tech, nightlife.
- **Buckhead**: old money. West Paces Ferry mansions, Lenox and Phipps malls, bars, the Governor's Mansion.
- **Old Fourth Ward, Inman Park, Little Five Points**: BeltLine, lofts, Ponce City Market, punk and vintage shops on Moreland and Euclid.
- **Westside, Bankhead, English Ave, Vine City**: warehouses turned breweries next to old, poor blocks under development pressure.
- **West End and the AUC**: the HBCUs (historically Black colleges) and the BeltLine Westside Trail.
- **East Atlanta and Zone 6**: grungy bars and trap-music geography.
- **Cabbagetown, Grant Park, Summerhill**: mill cottages, Krog Tunnel graffiti, Oakland Cemetery, the zoo.
- **Decatur** (its own city): a college-town square.

**North Fulton and north DeKalb**
- **Sandy Springs**: corporate towers at GA-400 and I-285, apartments along Roswell Rd.
- **Roswell**: a historic mill town; Canton St nightlife.
- **Alpharetta and Johns Creek**: rich tech suburbs. Avalon, cul-de-sacs, horse country in Milton.
- **Brookhaven, Chamblee, Doraville**: **Buford Highway**, with Asian and Latino strip malls. PDK airport. Doraville's speed-trap reputation.
- **Dunwoody and Perimeter**: office parks and the Perimeter Mall.
- **Tucker**: a blue-collar Main Street.

**Cobb County (northwest)**
- **Marietta**: the Square, the Big Chicken, Dobbins Air Reserve Base and the aircraft plant.
- **Cumberland, Vinings, Smyrna**: The Battery and the ballpark at I-75 and I-285, the Galleria, Market Village.
- **Kennesaw and Acworth**: KSU, Town Center, Kennesaw Mountain, Lake Acworth and Lake Allatoona.
- **Austell, Mableton, Powder Springs**: working-class areas, a Six Flags stand-in, the Silver Comet Trail.

**Gwinnett County (northeast)**
- **Norcross and Peachtree Corners**: a historic depot, Jimmy Carter Blvd, office parks, the self-driving test road.
- **Duluth**: Koreatown on Pleasant Hill Rd, the arena.
- **Lawrenceville**: the county seat, courthouse square, the jail, an airfield.
- **Lilburn and Snellville**: modest suburbs along US-78, and the BAPS mandir.
- **Suwanee and Buford**: a family suburb, the Mall of Georgia, the road to Lake Lanier.

### Roads and transit that must be right

- **Interstates**: I-285 (the Perimeter; the "Top End" is where the jams are), I-75, I-85, the **Downtown Connector**, I-20, GA-400, I-575, I-985, US-78 and GA-316.
- **Interchanges built by hand**: **Spaghetti Junction** (I-85 and I-285), the **Cobb Cloverleaf** (I-75 and I-285), GA-400 and I-285, and both ends of the Connector.
- **Express lanes**: I-85 Express and the reversible Northwest Corridor lanes on I-75/I-575. Barriers and few exits make them great chase set-pieces. GA-400's lanes are under construction until about 2031, so in the game they're cones, lane shifts and closed ramps.
- **Arterials**: Peachtree St, Peachtree Rd and Peachtree Industrial (the "everything is Peachtree" joke), Ponce de Leon, Buford Hwy, Roswell Rd, Cobb Pkwy (US-41), Memorial Dr, Moreland, Northside Dr, Fulton Industrial, Pleasant Hill, Satellite Blvd.
- **Transit**: the four rail lines of the city's transit system (under a parody brand) meeting at Five Points, the Downtown streetcar, buses, and the Amtrak stop at Brookwood.

### Landmarks (the first list for hand-built "hero" models)

| Area | Landmarks |
|---|---|
| Downtown | Stadium (parody name), arena, Centennial Park, the aquarium, the soda museum, the Gold Dome Capitol, Five Points |
| Midtown | The Fox, Piedmont Park, Bank of America Plaza, the Varsity-style drive-in |
| Buckhead | Lenox and Phipps, the Governor's Mansion |
| Southside | Grady-style trauma hospital, the county jail on Rice St, a film studio on the old Fort McPherson |
| Cobb | The ballpark and The Battery, the Big Chicken, Marietta Square, Kennesaw Mountain, the theme park, Lake Allatoona |
| Gwinnett | The arena, Mall of Georgia, Lawrenceville square |
| Edges | **Hartsfield-Jackson** (terminals, runways, cargo ramps, the rental-car center; flying comes later), **Stone Mountain** (the dome, the walk-up trail, the laser show lawn), **Lake Lanier** (marinas, houseboats, Buford Dam), **Lake Allatoona** (coves, boat ramps) |
| Everywhere | Spaghetti Junction, the Chattahoochee River (tubing, the river parks) |

**Built so far (twenty-one heroes in the Downtown tile, `tools/blender/landmarks/`, `docs/contracts/m1-tile-format.md` "Hero landmarks"):** the stadium (the folded silver shell, the eight-petal pinwheel roof, the halo board), the Capitol (the gold dome, the porticoes), the Westin-style mirrored tower, the saucer-and-dome hotel, the arena, the aquarium, the soda museum, the observation wheel, the Fountain of Rings, Truist Plaza, 191 Peachtree, the Flatiron and the Candler Building, then the Georgia-Pacific Tower, the Marriott Marquis, the State of Georgia Building, City Hall, the Hurt Building, the Central Library, Corey Tower and the Hilton (the Basilica's model is built and waits for the tile north of this one). Each replaces its generic building in the bake, has its own collision hull, and takes the real footprint, height and orientation from the map data; the street-name label shows the landmark's name as you walk up to it. They are script-built interpretations with no brand marks (`tools/blender/LICENSES.md`).

**Sensitive sites are on the map and treated with respect**: the MLK historic sites, Stone Mountain's Confederate carving, the police training center ("Cop City"), Lake Lanier and the flooded town of Oscarville. They're built carefully and never played for laughs, and no missions or gags happen at them. Real gangs, real crimes and real people stay out entirely.

---

## Gameplay

### Crime, heat and the police

The design draws on GTA V (line-of-sight search and the last known position), GTA VI (witnesses and descriptions), Watch Dogs (stopping the 911 call) and Mafia II (a separate wanted status for your car and for you).

1. **A crime happens.** Witnesses within sight or earshot react. A witness who decides to call **reports it after a few seconds**. You can stop the call (scare them, grab the phone), or not.
2. **A description record** stores what the police know: *face*, *clothes*, *vehicle and plate*, *CCTV*. Each one can be cleared on its own: change clothes, respray, swap plates, get a haircut.
3. **Heat level (1–6 stars).** Stars are hollow while the police only have a report, solid when they've seen you, and flashing when you've broken line of sight. Search mode centers on your last known position, and police units have vision cones on the minimap.
4. **Dispatch comes from data tables**, the way GTA V's `dispatch.meta` works: for each service and heat level, the maximum units, spawn interval, vehicle set and loadout. Escalation runs from patrol units to helicopters with spotlights, then roadblocks and spike strips, SWAT, a state investigations task force, the feds, and the National Guard at 6 stars.
5. **Jurisdiction is the signature mechanic.** It mirrors real policy:
   - **City police (APD stand-in)**: restrictive pursuit rules. Minor crimes mean no vehicle chase, but a dense camera network raises "investigation heat" that follows you. Six patrol zones map onto districts.
   - **State Patrol (GSP stand-in)**: owns the interstates and express lanes. Aggressive pursuit and **PIT maneuvers** at speed, and heat escalates fast.
   - **County and suburban police** (Cobb, Gwinnett, DeKalb, Fulton, and city departments such as Marietta and Sandy Springs): in between. Small-town departments are ticket-happy (speed traps).
   - **Transit police** control the stations and trains.
6. **Getting out**: break line of sight and wait out the cooldown, hide in a garage or safehouse, use a paint shop or plate swap, call a "lawyer" contact to pay it down, or get busted or wasted. Getting busted costs cash and weapons, and repeat street-racing busts **impound the car**, as Georgia law now does.

**Built (first pass):**
- Crimes are decided from sim events by `src/sim/law/Law.ts`, using the engine table `src/shared/data/crimes.json`: `carjack`, `assault`, `hit_ped`, `kill_ped`, `assault_officer`, `vehicle_theft` (only if someone sees it), and the gun crimes `discharge` (firing in public: severity 1, heat 1) and `shoot_ped` (severity 4, heat 2). A witness is a civilian inside the crime's radius with a clear line (a ray against the static world), and the victim always counts. Gunfire is also *heard*: a crime with a `hearRadius` (and the weapon's `hearM`) is noticed by civilians out to that range with no line needed, who never saw a face. **Not everyone calls**: about 60% of those who saw it (85% of the victim, 45% of those who only heard) do, the rest just run. A caller takes **8 to 20 s** to get through, with a phone over their head (the client's dialling marker), and hangs up if they are knocked down or killed (`witness:silenced`), lose sight of you for 5 s, or run 90 m off (`witness:gave-up`): you can stop the call. Several calls about one crime are one report. An officer who sees it reports it at once.
- **Escalation is earned** (`crimes.json` `points`, `violent` and `rules.escalation`): one star for a first reported crime; two for a severity-3 crime (running someone over, shooting or killing a pedestrian) or repeated crimes (5 points of reports in a run of heat); three only for sustained violence (7 violent points: a kill and another) or an attack on police; the helicopter at three after about 30 s. Time alone never raises the heat, and a minor crime nobody sees makes none.
- Heat is tracked in the sim (`src/sim/law/heat.ts`): hollow stars while only reported, solid when the police see you, flashing when they lose you, and it clears after a time out of sight that grows with the level. What the police know (car and plate, clothes) is recorded in the `crime` event's `description`.
- **The 911 cue** (`src/client/ui/LawHud.ts`): no toast. When a witness's call goes through the hollow stars pulse and a small "911, police notified" tag shows under them for about two seconds; while a witness is dialling, a phone with a filling ring floats over their head (`PedFlag.Dialling`, progress in `Aux2`), a chance to knock them down before it ends (the marker flashes red). `node scripts/call-shots.mjs` takes the screenshots.
- Dispatch reads the city pack's `jurisdictions.json` through the tile id (`docs/contracts/law-data.md`). Cars are sent 6 to 12 s after a report at one star (a rise in the heat costs the radio a few seconds) and appear out of the camera's view, 250 to 330 m away at one star down to 120 to 200 m at five (`police.json` `dispatch`; a spot whose streets make a long detour is passed over), so the first car takes 25 to 45 s from the call to reach the scene; one unit at heat 1, a second 30 s later at heat 2. They are placed on the lane graph where the tile has one and on the road centrelines on the freeways (the lane graph's connected part leaves them out), in the livery of the agency whose area covers where the police believe the player is. They drive with a pure-pursuit controller and a speed governor (`src/sim/police/pursuit.ts`, `driving.ts`). A restrictive agency does not chase a car for a crime below its `minPursuitSeverity`: it gathers at the scene, and gets out to chase on foot if you are on foot. An officer within 1.5 m of a player who stands still for 2 s arrests them.

**Built (the escalation ladder, heat 1 to 6):** the numbers are in `src/shared/data/police.json` (engine rules) and the city pack's dispatch rows; the code is in `src/sim/police/`.
- **Who comes.** Each agency's row for the heat level gives its maximum units, spawn interval, units per spawn and loadout; missing levels inherit the nearest lower one. The agency that owns the road the player is on sends cars (the Highway Patrol on the freeways, the city police on the streets); task forces join anywhere at their `minHeat` (the investigations task force at 4, the feds at 5, the Guard at 6). Cars wear their agency's livery. **Unmarked** agencies (`unmarked: true`) drive plain cars with no stripe or lightbar, and their strobes and siren come on only while the unit is chasing. From heat 3 a second officer rides in the passenger seat.
- **Roles and tactics.** Every unit that may chase a car takes a role (`tactics.ts`): the nearest car behind the target is the **chaser** (it follows and PITs), a **flanker** routes on the lane graph to a parallel street (the lanes of the target's street are made expensive) and comes at it from the side, and a **blocker** drives to the **intercept point** on the player's predicted route (the lane graph, or the road centrelines, followed straight on unless the yaw rate says the player is turning) and parks across the road. Roles are re-dealt every 1.5 s and held for 4. Police take the next lane over to pass what is in theirs, and traffic with a siren behind it edges to the kerb (right in the right lane, left on the left of a one-way street, away from the police between).
- **PIT** (agencies with `pit: true`, the Highway Patrol): the chaser runs up the target's flank, holds alongside the rear quarter for at least 1.4 s in plain view (the warning), matches speed, then turns in. The shove turns the tail round (`RaycastCar.pitKick`: a yaw kick, and for 1.8 s the slide assists let go and the rear tyres hold little), so it spins the target at any speed from 12 to 28 m/s, in a coupe, sedan or pickup, whether the player counter-steers or not. It is fair in that it is telegraphed, a hard brake while it lines up makes it abort, and a hit buys 8 s with no second PIT (11 s of cooldown after any attempt). **Ramming** starts at heat 4: after the target at 4 m/s over its speed from inside 14 m, with a 5 s cooldown and 4 s of grace after a hit.
- **Roadblocks** (heat 3 and up, one at a time, two from heat 5): when the player is driving and in sight, 2 or 3 cars are laid angled across the road on the predicted route, 150 to 250 m ahead, on a straight stretch clear of junctions and out of the camera's view (it waits up to 6 s for a hidden site), with an officer standing behind each car, armed. Sometimes one gap of 4.6 m is left to thread (60% at heat 3, none from heat 5). Passed, or after 80 s, the officers get back in and the cars join the chase if the agency has room under its cap, and go home otherwise.
- **Spike strips** (heat 3 and up): a strip across the lane 18 m in front of every roadblock, and one laid by a Highway Patrol blocker as it arrives at its meeting point. A wheel that crosses it goes flat (`RaycastCar.deflate`: the wheel sits 30% lower, grips 35% less and drags, so four flats limp along at about 5 m/s). The test is the wheel's path over the tick against the strip, so no speed skips it. Police cars drive over their own strips. A strip lies 45 s.
- **Helicopters** (heat 3 and up, 26 to 34 s after the heat first reaches 3: one, two from heat 5; `helicopter.ts`): a kinematic entity that flies in, then orbits the target at 60 to 90 m (clearing the tallest roof under its path by 28 m) or sweeps the search area. It sees through a downward cone of 42 degrees half-angle with a clear line, which counts as "seen" (the stars go solid); at night the cone shrinks to 70% (the searchlight and the street lamps) and the searchlight flag goes up. Stand-in model with a spinning rotor and a beam; a rotor thump in `AudioSystem.ts`.
- **Gunfire** (heat 3 and up, or at once when the player shoots at police): officers on foot and passengers in cars fire their loadout's weapon through the weapons API (`weaponsPort.ts` -> `pullTrigger` -> `fireWeapon`; the driver drives). A reaction time of 0.5 to 1.1 s after the sighting, bursts of a few shots (pistol 2 to 4, shotgun 1 to 2, rifle 3 to 5) with a pause between, and a cone that widens with range and with how fast the target moves. They do not fire through a civilian, a car or a wall (a ray and a distance test against everyone in the line); a bystander just off the line is the risk they accept. Passengers draw their pistol from a window (the API only allows pistols and SMGs from a car).
- **Losing them.** From the last known position the search area grows (`searchStartM` at the heat level, `searchGrowMps` a second, up to 320 m) and cars spread over it, looking first down the road a car that got away was on. Hollow stars (nobody has seen you yet) hold for 30 s, and for as long as a car is still on its way, before they begin to cool. The cooldown (out of sight) is 20, 35, 70, 100, 125 and 150 s by heat level, and from heat 4 it runs at half speed while the player is inside the search circle and at 30% again while a helicopter is within 170 m, so heat 4 and up is hard to shake and possible: get out of the circle and out of the sky.
- **For the minimap:** the snapshot header carries the search area (`SearchX`, `SearchZ`, `SearchR`) and the counts of roadblocks, helicopters, spike strips and cars with a role; helicopters and spike strips are entities (`EntityKind.Helicopter`, `SpikeStrip`); a roadblock car has `VehicleFlag.Roadblock`, a car's role is in `VehicleFlag.RoleShift` and an officer who sees the player has `PedFlag.Sees` (`officerCone()` in `src/shared/policeRules.ts` gives the cone to draw).
- Quick-test parameters: `?peds=N` (idle bystanders near the spawn), `?armour=N`, `?weapons=all|none`. Ambient pedestrians count as witnesses like anyone else (see below): `?ambient=0` takes them away for a scripted scene.

### Pedestrians and the ambient city

- **A population cycle per zone type** (modeled on GTA's `popcycle`): two-hour slots, weekday and weekend, with a budget for peds and cars and weighted model groups (business, students, nightlife, Buford Hwy shoppers, game-day crowds).
- **Spawn ring**: things spawn 60–120 m out and out of view, and despawn when far away and unseen. Anything the player has touched becomes persistent.
- **Scenario points**: benches, bus stops, ATMs, food trucks, BeltLine joggers, Waffle House counters. Peds spawn already doing the activity, which reads as alive for little cost.
- **A random-events director**: every few minutes it picks an eligible event (by zone, time, heat and cooldowns), such as a mugging, an ATM robbery, a getaway driver, a takeover forming at an intersection, or a fender-bender fight.
- **Events and weather**: game days at the stadium and ballpark, Dragon Con weekend, pollen season (yellow cars), summer thunderstorms and flooding, and traffic jams on the Top End.

**Built (first pass: sidewalks, no events director yet):**
- **A walk network** baked with the tile (`paths.json`, 135 km in the Five Points tile): every mapped sidewalk, footway, pedestrian street and crossing, synthetic sidewalks along both curbs where a street has none, everything cut clear of building footprints, and a crossing across every junction leg, each tagged with the junction and the leg it crosses. **Scenario points** (`scenarios.json`): benches, bus stops, ATMs, shop and restaurant fronts, park lawns, plazas and signal corners, from OSM where it has them and synthesised fill where it does not. Contract: [docs/contracts/m1-tile-format.md](docs/contracts/m1-tile-format.md).
- **The population** (`src/sim/peds/`) follows the city's `population.json` ([contract](docs/contracts/population-data.md)): the zone, the clock's two-hour slot and weekday or weekend give the density, the kinds of people (outfits, walking pace, walking or already doing something) and the scenarios they favour. Sixty people on High, 40 on Medium, 24 on Low, never so many that the 256-entity snapshot has no room for traffic and police. They are made 40 to 120 m out where the camera cannot see, weighted toward the streets near you, and removed when far and unseen. Anyone you touched (hit, carjacked, a witness the law is waiting on, someone who fights back) stays.
- **Walkers** follow the graph (turning mostly straight on, rarely back), keep to a side of the sidewalk, step round each other and round you, and **cross at crossings on the walk light** (`walkState` in `src/shared/signals.ts`, the same phases the cars obey), or in a gap in the traffic where there is no light. People standing at a point are already sitting on the bench, waiting at the stop (some on the phone), at the cash machine, chatting in twos and threes.
- **Reactions** run through the carjacked driver's brain: violence, a carjacking and an explosion make bystanders run (some cower, some hold a phone up and film it); a crash, a smoking, burning or burnt wreck draws stares; a fast car close by makes people jump back; a car on the pavement sends them running. Witnesses are ordinary civilians to the law, so a carjack on a busy sidewalk is called in by bystanders, and knocking out a caller stops that call.
- **Drawn** as instances: everyone but the player and officers is a few instances of five shared meshes (the whole crowd is five draw calls), walking, running, sitting, on the phone, filming, chatting, at the machine, cowering. Benches and bus stops are instanced props. Far-off and standing people skip the character controller in the sim.
- **Solid, and nobody stuck** (`src/sim/World.ts`, `src/sim/character/unstick.ts`, `src/shared/props.ts`): everything drawn as a solid is solid, from the same lists the client draws it from: building walls (courtyards open), decks and piers from `collision.bin`, and signal poles with their mast arms, benches and bus stops from `lanes.json` and `scenarios.json`, as fixed Rapier boxes in their own collision group (cars, people and bullets hit them; the camera and sight lines do not). A person who glides (far off, or standing) keeps out of walls and props; every spawn is checked against the footprints and the physics world; the width of each walk edge is measured against the real world the first time anyone walks it, and edges a low deck, a pole or a cliff block are not routed. Under everybody on foot is a safety net: someone inside a building, overlapping a wall, under the ground, or (an NPC) trying to move and getting nowhere for seconds is put on the nearest clear spot, or the nearest spot on the walk network, or (unseen) removed, with a `ped:unstuck` event. `?debug=collision` draws the collision meshes (magenta buildings, orange decks and piers), the furniture boxes (cyan) and the player's capsule over the world, and logs each fix to the console. `npm run audit:collision` plays 10 minutes of Downtown headless and counts people in walls and stuck ([docs/perf.md](docs/perf.md)).
- Quick-test parameters: `?ambient=0` (no pedestrians on the sidewalks), `?pedbudget=N` (the most at once), `?time=HH:MM&day=N` (the clock: lunch against 4 a.m.).

### Traffic

- A **directed lane graph** generated from OpenStreetMap (lanes, one-ways, speed limits, signals), plus hand fixes at the big interchanges.
- **Car following** uses the Intelligent Driver Model (IDM), **lane changes** use its companion rule MOBIL, and **junctions** use signal phase tables and stop and yield queues. Drivers honk, swerve, flee gunfire and road-rage.
- **Simulation detail by distance**: a full raycast-physics car near the player, a kinematic spline follower in the middle distance, and a statistical density far away. This is what makes dozens of cars affordable in a browser.
- **Vehicle sets per zone and time**: pickups in the exurbs, sedans and EVs in Midtown, donks and box Chevys on the Southside at night, transit buses on real routes.
- **Pursuit AI** drives toward the predicted intercept point. Units take roles (chaser, flanker, blocker) and PIT from the rear quarter. Roadblocks spawn on the lanes you're likely to take. **Built:** see "Built (the escalation ladder)" under [Crime, heat and the police](#crime-heat-and-the-police).

**Built (first pass):**
- The pipeline writes `lanes.json` (`tools/pipeline/src/world/lanes.ts`, documented in the tile contract): lanes per direction from `lanes` and `oneway`, trimmed at junctions, a connector for every straight, left and right movement with its conflicts and who gives way, speeds from `maxspeed` or the road class. The sim routes only over the largest strongly connected part of it (81% of surface-street length on the Downtown tile; freeways run off the clipped tile).
- Signals are a pure function of the junction and the time (`src/shared/signals.ts`: two approach groups, fixed cycle tables, offsets from the junction id), so the sim, the client's lamps and the pedestrians' walk lights agree for free. Heads on poles are three instanced meshes.
- `src/sim/traffic/`: IDM, a MOBIL lane change, signals, stop signs (stop, then arrival order) and yielding from the conflict data, random turns or A* to a destination. Cars within about 80 m of the player (or of any other moving car, or after any contact) are full raycast cars with a driver ped, steered along the lane by pure pursuit; farther out they are kinematic followers on the lane spline, still entities in the snapshot. The switch keeps pose and speed. Cars spawn 120 to 230 m out and out of view, as many as the city's `population.json` asks for at that spot, slot and day, up to 40 on High (30 Medium, 20 Low; `?traffic=0..1` scales it, `?traffic=0` turns it off).
- Drivers stop for pedestrians and for the player in the lane, honk at the player who blocks them (`traffic:honk`), edge round parked cars, brake hard and swerve for a car coming at them, drive faster and wilder after an explosion or a nearby crime (`traffic:react`), and pull over for a police car with its lights on. A car at a red light can be carjacked through the usual flow. Far traffic is drawn from instanced meshes, near traffic from the full model; brake lights and headlamps (bright at night) follow the car and the clock.

### Driving

- A **raycast-suspension car** built on Rapier rigid bodies and ray casts (written by us, not Rapier's stock vehicle controller), aimed at **GTA IV's feel**: heavy cars (1,380 to 2,150 kg) with momentum, soft long-travel suspension that visibly rolls, dives and squats, grip that moves with the weight, slides that build gradually and can be caught, and crashes that land heavily. No assist holds a slide or a donut. [docs/physics.md](docs/physics.md) has the model, the numbers and how to tune each vehicle.
- Tunables in the spirit of GTA's `handling.meta` but in SI units: mass, centre of mass and inertia, spring frequency, bump and rebound damping, anti-roll and roll centres, a load-sensitive slip curve (`mu`, peak slip angle, slide ratio), power and brakes, and a rack that slows at speed. They are stored as JSON per vehicle in `src/shared/data/handling.json`. The pure maths is in `src/sim/vehicles/dynamics.ts`, and `tests/handling.test.ts` holds the feel as GTA IV envelopes:
  - **Pace**: 0 to 100 km/h in 9.0 s (sedan), 5.7 s (coupe) and 11.6 s (pickup). Braking from 100 km/h takes 38 to 45 m.
  - **Grip and roll**: about 0.83 g on a skidpad with 6.4° of body roll on the sedan, 8.7° on the pickup and 2.9° on the coupe. The nose dives 3.4° under hard braking.
  - **Weight transfer**: lift off mid-corner and the tail steps out (catchably); turn in too fast and the front ploughs on.
  - **Handbrake**: it locks the rears. A tap flicks the tail and the car straightens hands-off in under a second; a long pull brings it round. Throttle with the brake (or the handbrake) burns out, and with the wheel turned the spinning rear swings the car round in a donut.
  - **Crashes**: a little bounce (restitution about 0.15 to 0.3), momentum passed from car to car, and a slide sideways into a kerb rolls the car (from about 30 km/h in the pickup, 45 km/h in the sedan).
  - Three stand-in vehicle types: the sedan, the coupe (nimble and tail-happy) and the pickup (heavy, soft and wallowy). Add more in `src/shared/data/handling.json`; `?car=<id>` picks the starting car.
  - **Keyboard**: a held steering key winds on more slowly at speed and stops short of full lock, so a tap on the motorway is a lane change.
- **Cheap damage**: dent morph targets blended by impact, detachable bumpers and panels, and smoke and fire driven by engine health.
  - **Built (stand-in):** body and engine health from the velocity change of each crash, scaled by the `damage` block of `handling.json` (`collisionMult`, `engineMult`, ...). The engine smokes below 42%, dies at zero, may then catch fire, and a burning car explodes after 5 to 8 s: a flash and a charred shell that never drives again. Whoever is still inside is hurt by the fire and killed by the blast.
- Vehicle types (later): motorcycles, boats on the Hooch and the lakes, helicopters.

### Gangs (fictional)

- **Six invented crews** ([draft in CAST.md](docs/CAST.md#the-crews)), each with turf in particular districts, its own colors, cars, music taste and graffiti tags, and a different kind of business:
  - **The Ashes**: East intown chop shops.
  - **The Paces Ferry Boys**: Buckhead trust-fund party drugs.
  - **Gulch Holdings**: Downtown crime through real estate, and the big fish.
  - **The Hollowell Royals**: the Westside.
  - **Night Market**: Buford Hwy racing and takeovers.
  - **Kennesaw Iron**: north Cobb bikers.
- **No real gang names, symbols or hand signs**, and no real rappers or cases.
- **Turf reacts to you.** Each crew has a reputation meter for the player, like Saints Row's notoriety. Wear their rival's colors on their block, rob their corner or crash their car meet and they come for you. Help them and you get work, discounts and backup.
- **Turf is a living layer.** It sets who hangs out on the corners, which cars park on the street, the graffiti, and random events (a drive-by, a dice game, a car meet, a crew war spilling into traffic).
- **Gangs and police share one world.** A shootout between crews draws police heat to the block whether you're there or not, and you can use a gang war to cover a getaway.

### The protagonist

**Keon "Kudzu" Mabry** (draft; [CAST.md](docs/CAST.md#the-protagonist-keon-kudzu-mabry)): a 29-year-old laid-off tow-truck driver from Reynoldstown, living in a weekly-rate motel off the Connector.
- **What he brings:** he knows every lot, impound yard and back road, which explains the car theft, and his first side work is tow and repo jobs.
- **The long-term goal:** buying back his late grandmother's flipped house, the most expensive property in the game. It gives money a point without a scripted story.
- **Later:** a character creator, once the world is built out.

### On foot

- A third-person controller (Skyrome's capsule, step-up, climb and camera code is a starting point), with cover, hitscan shooting with soft lock-on (gamepad and touch need it), and melee.
- **Carjacking** follows the door sockets: walk up, open, pull the driver out, get in. Drivers flee, fight back or chase you, depending on personality.
  - **Built (stand-in timing):** you start on the sidewalk a few metres from a car parked at the curb with a driver in it. Walk to the driver's door and press the use button: the door opens, the driver is dragged out (about 1.4 s in all, `src/sim/carjack.ts`), and you take the wheel. The driver rolls a personality from the seed, then flees along open ground (`src/sim/npc/flee.ts`) or squares up and throws punches for a few seconds before running. The sim emits a `carjack` event for the later law and heat system. Empty cars, including the one you just left, are entered with the same button; a few empty parked cars of mixed types sit along nearby curbs.
  - Quick-test URL parameters: `?start=car` (beside an empty car), `?start=jack` (at the driver's door of the occupied car), `?driver=flee|fight` (force the reaction), `?car=pickup`, `?parked=N`.
- **Built:** health and armour for the player and every ped, a `damage` event for each hurt (melee, vehicle, fall, explosion, fire), knockdown and death as **ragdolls** (below), and a punch on its own key (`Q`, or X on a pad, or the touch Punch button) with a short cooldown, a hit cone and a soft lock-on. Cars hurt peds by closing speed above 3 m/s. A dead player gets the WASTED screen and respawns at the tile's player spawn with the heat cleared; getting busted does the same.
- **Built (guns, first pass):** a pistol, an SMG, a shotgun and a rifle (`src/shared/data/weapons.json`; the API for the player and for any NPC is documented at the top of `src/sim/combat/weapons/api.ts`). Hitscan with a Rapier ray against the world, cars and people: damage falls off with distance, headshots hurt more, the shotgun throws eight pellets, the aim blooms as you fire. A hit flinches a ped, knocks one down or kills; it dents a car's body, hurts the engine more on the bonnet, hurts a driver through the cabin and can flatten a tyre. The player starts with a pistol (`?weapons=all` gives all four, `?weapons=none` none).
  - **Keyboard and mouse:** hold right mouse (or `Z`) to aim, left mouse (or `G`, or Enter) to fire, `T` to reload (`R` is the car reset), `1` to `4` or `[` and `]` or the wheel while aiming to change weapon, `X` for cover. **Gamepad:** LT aims, RT fires, X while aiming reloads, the D-pad left and right change weapon, B takes cover; in a car RB aims and X fires. **Touch:** Fire (drag it to turn), Aim (a toggle), Reload, Gun and Cover buttons above the main cluster.
  - **Aim:** an over-the-shoulder camera with a narrower field of view and a crosshair whose gap is the bullet spread. The sim rebuilds the crosshair ray from the camera angles in each command (`src/shared/aim.ts`), so the bullet goes where the crosshair is. A soft lock-on bends the shot toward a threat near the crosshair: strongly for a gamepad or a finger (a wide cone, a marker on the target), by a hair for a mouse.
  - **Drive-by:** aim from the driver's seat with the pistol or the SMG (the camera sits at the driver's eye, inside the cabin, and the shot leaves the window on the side you face). A rifle or a shotgun will not come out of a window.
  - **Cover:** `X` next to a wall snaps the character against it: crouched behind a low wall (about 0.5 to 1.6 m), flush against a high one. They slide along it, stop at its end, stand (low) or lean out (high) to shoot while aiming, and leave on `X`, a jump or a sprint. Stand-in poses; nothing yet makes cover safer than the geometry it is.
  - **Ripples:** every shot is a `discharge`; people nearby run, cower, look or (rarely) film; drivers floor it, and a timid one whose car is shot at gets out and runs.
- **Built: ragdolls (Euphoria-lite).** A car above about 15 km/h, a punch or bullet that knocks someone down, a hard landing, a blast or a death turns the body into an 11-part Rapier ragdoll with the momentum it had. People fold over the bonnet and roof at speed (thrown about 5, 14 and 30 m by a braking car at 30, 50 and 80 km/h), are thrown by explosions and slump when killed. Once still, the living blend back to standing; the dead stay down. A nudge at walking pace, or a sprinting player running into someone, makes them stagger and catch their balance instead. At most six ragdolls have bodies at once; the oldest freeze where they lie (`src/sim/ragdoll/`, docs/physics.md).
- **Weight on foot**: the top speeds (walk 1.5, jog 3.3, sprint 5.5 m/s) take about a quarter of a second to reach, a sprint ends in a short slide, and turning is a little slower.

### Side activities (backlog)

| Jobs | Racing and cars | Hustles and crime | Atlanta flavor |
|---|---|---|---|
| Rideshare (game-day surge, airport runs) | Street takeovers (donut score vs heat) | Chop-shop export lists | Waffle House-style 3 a.m. shift |
| EMS shifts to the trauma bay | I-285 night races | Store, ATM and armored-truck robberies | Lemon-pepper wing delivery |
| Firefighting (house fires, kudzu brush fires) | Fulton Industrial drift events | Bail recovery (bounty hunting) | Buford Hwy food crawl |
| Highway-assist truck: clear Connector wrecks | Express-lane time trials | Game-day ticket scalping and lot parking | Film-set runner and stunt driver |
| Tow and repo man | Custom shop and car meets | Airport cargo smuggling | Trap-music career: beats, mixtapes, the club DJ |
| Traffic-chopper reporter | Boat and jet-ski races on Lanier and Allatoona | Storm-cleanup insurance scams | Hooch tubing, Dragon Con scavenger hunt |

### Radio: bring your own music

Licensed music is out, and so is streaming from Spotify or Apple Music:

- **Spotify's Developer Policy forbids it outright** ("Do not create a game"). It also forbids syncing music with visuals or mixing it with other audio, and since 2026 an unapproved app is limited to 5 users.
- **Apple Music (MusicKit JS)** has no explicit ban on games, but its terms forbid syncing or modifying the music, and ducking it under game sound counts as modifying. Each player would also need an Apple Music subscription. **Decision: skipped.** It could be revisited as a plain player (play, pause, skip, no ducking), but it's a legal grey area and Self Radio covers the need.

The radio instead has three kinds of station:

1. **Self Radio**, as in GTA V. Players load their own music files (the file picker works in every browser, including iPhone Safari), and the tracks are kept in the browser's own storage between visits. Because the files are the player's own, the game can do everything a real station does: crossfades, ducking under sirens, procedural DJ chatter and ads between tracks. In multiplayer this audio **never leaves the player's machine**.
2. **House stations.** Procedural and CC0 music (the same approach as Skyrome's audio), plus parody talk radio and ads that mock the parody brands.
3. **Radio off / External**, which mutes the in-game music so players can run Spotify, Apple Music or anything else in another tab or app. The game never touches those services.

### Economy and progression

- **Money in**: crime, car exports, side jobs, heists (later) and businesses.
- **Money out**: safehouses (save points that clear heat if you arrive unseen, with a wardrobe), garages (store and insure cars), weapons, clothes, car mods.
- Stats that improve with use (driving, shooting, stamina), and reputation by neighborhood.
- **Money is a ledger of events**, not a free number. That makes saves migratable and a server able to validate them later.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** (strict) | Most game code is written by AI agents, and they're fastest and most reliable in TS. The same code can run in the browser, a Web Worker and a Node/Bun server. |
| Build | **Vite** | Fast dev server, worker and WASM support. Proven on Skyrome. |
| Renderer | **three.js, WebGLRenderer first** | The biggest ecosystem and example corpus. In 2026 benchmarks (r183), `WebGPURenderer` still costs about 2× the CPU per draw of `WebGLRenderer` in scenes with many meshes. WebGPU is also still behind a flag on Linux/AMD (the owner's dev box) and Linux Firefox. We keep shaders small and the renderer behind an interface, so we can A/B `WebGPURenderer` each release and switch when it wins. |
| Physics | **Rapier 0.21** (`@dimforge/rapier3d-simd-compat`) | WASM, fast, works in workers and Node, proven on Skyrome. Our own raycast car runs on top. **Jolt** (`jolt-physics`, best-in-class vehicles, multithreaded WASM) is the fallback if handling can't be made right. |
| Hot paths | **Rust → WASM**, only where profiling demands it | Candidates: traffic and lane-graph simulation, pathfinding, heavy steps in the world pipeline. One crate compiled to WASM runs in the browser and on the server. |
| Threads | **Web Workers + SharedArrayBuffer** | The simulation runs in a worker and the main thread renders. Needs cross-origin isolation (COOP/COEP headers). Falls back to `postMessage` with transferable buffers when the page isn't isolated. |
| Assets | **glTF + meshopt** (`EXT_meshopt_compression`), **KTX2/Basis** textures, **3D Tiles-style** tile hierarchy | Compressed on the wire and on the GPU, and streamable. `3d-tiles-renderer` (NASA-AMMOS) is a reference for tile LOD. |
| World pipeline | **Node + DuckDB + GDAL + PDAL + osmium** (offline) | Turns OpenStreetMap, Overture, USGS 3DEP elevation and lidar, NLCD land cover and MARTA GTFS into baked tiles. |
| Audio | Web Audio, procedural and CC0, plus the player's own files for the radio | Same approach as Skyrome. See [Radio](#radio-bring-your-own-music). |
| Hand-built assets | **Blender 5.2** (installed on the dev box), driven headless by Python scripts (`blender -b --python`), exporting glTF | For hero landmarks, vehicles, the protagonist and props that procedural generation can't do well. Scripts live in the repo, so assets can be regenerated and reviewed. |
| Tests | **Vitest** for pure logic; **Playwright** for real-browser checks (controls, perf budgets, soak) | Skyrome's `check:controls`, `perf-budget`, `soak` and `leaks` harnesses get ported early. |
| Hosting | **Cloudflare Workers static assets + R2** (`_headers` for COOP/COEP; tiles in R2 with free egress) | Can send the cross-origin isolation headers that GitHub Pages can't. Pages is limited to 25 MiB per file and 20k–100k files; R2 holds the map. Durable Objects give us multiplayer rooms on the same account. |

### Why not…

- **Bevy (Rust → WASM)**: one language for client and server is attractive, but it's effectively single-threaded on the web and its WASM binaries are large. Every release breaks the API, and Rust compile times slow AI-agent iteration a lot. Too risky for a browser-first game today.
- **Babylon.js 9**: a real contender. It has the best built-in large-world support (an experimental floating origin) and free Havok physics, but no shipped vehicle controller. Moving to it would cost the toolkit we already have (batching, LOD, freezing, memory release, perf harnesses).
- **PlayCanvas**: good engine, editor-centric, with a smaller corpus of code for agents to learn from.
- **Godot 4 web export**: WebGL2 only, no C# on the web, threading friction. Not suited to a demanding open world.
- **Unity Web / Unreal**: heavy downloads, poor fit for agent-driven development, and Unreal has no official web target.
- **Google Photorealistic 3D Tiles / Cesium OSM Buildings**: the terms forbid caching, extraction and offline baking, and the meshes are useless for collision.

---

## Architecture

The single rule that makes multiplayer possible later is to **keep the simulation separate from the presentation.**

```
┌──────────────── main thread ────────────────┐      ┌──────────── sim worker (later: server) ────────────┐
│ input → InputCommand {tick, buttons, axes}  │ ───▶ │ fixed 60 Hz step                                   │
│ render (three.js): interpolates snapshots   │ ◀─── │   physics (Rapier), vehicles, peds, traffic,       │
│ audio, UI, camera, streaming of visuals     │      │   police & heat, economy rules (event-sourced)     │
└─────────────────────────────────────────────┘      │ emits snapshots + events                           │
              ▲  Transport interface                 └────────────────────────────────────────────────────┘
              └─ LoopbackTransport (single player) │ WorkerTransport │ later: WebTransport / WebSocket
```

- **Fixed 60 Hz simulation**, deterministic where it's cheap: seeded RNG per subsystem, and ambient population seeded by (cell, time slot).
- **The input-command pattern**: the player controller consumes `{tick, buttons, analog, aim}` commands, never raw keys. Single player feeds local commands, and a network later feeds the same structs.
- **One entity registry** with stable IDs and serializable component state (transform, velocity, health, owner and authority flags), quantization-friendly from the start.
- **Event-sourced rules**: crimes, damage, money and heat changes are events handled by a rules module. That module becomes server code later, and the UI listens to the same events.
- **Two kinds of population**: *cosmetic* (local, seeded, never networked) and *significant* (police, anything the player touched, mission entities: networked later).
- **Data tables in JSON** (vehicle handling, dispatch, popcycle, vehicle groups, scenario points, side activities), shared by client and server.
- **A transport interface from day one**, with a loopback implementation. That lets us test with latency and packet loss injected long before a server exists.
- **Skyrome conventions carried over** where they fit: Systems with priorities, `Game` services added through declaration merging, actions rather than raw keys (trackpad-first bindings, gamepad, touch), graphics tiers with `lodScale`, and freezing static matrices.

---

## City packs

Atlanta is the first city, not the only one. The engine knows about *districts*, *jurisdictions*, *crews* and *brands*, never about Peachtree Street. A city pack is a folder of data plus a few hand-built assets:

```
data/cities/atlanta/
  city.json          name, bounding polygon, projection, real-world data sources
  warp.json          control points and compression zones (real coordinates → game coordinates)
  districts.json     district polygons, popzone types, time-of-day population cycles, vehicle groups
  jurisdictions.json police agencies, their polygons, pursuit style, dispatch tables
  crews.json         gangs: turf polygons, colors, cars, business, reputation rules
  brands.json        parody brands, mapped to the real ones and placed by POI category
  landmarks.json     hero landmarks: position, footprint, the Blender script or glTF that builds each one
  overrides/         hand-built interchanges, road fixes, map edges
  radio/             talk-radio and ad scripts for the house stations
  CAST.md            the protagonist, crews and agencies, in words (Atlanta: docs/CAST.md for now)
```

**Adding a city** means running the same pipeline over a new area, then writing its pack: districts, agencies, crews, brands and landmarks. The pursuit styles, the heat ladder, traffic, population cycles and side activities are shared rules that each pack only parameterizes. The protagonist stays the same across cities until there is a character creator, and later cities may bring their own.

What makes a city a good candidate: open map data (OpenStreetMap plus elevation data), distinct districts, a real difference in policing between jurisdictions, and a highway network worth chasing on.

## The world pipeline

An offline, versioned pipeline turns open data into game tiles. Nothing on the map is hand-placed unless it has to be.

1. **Area and projection.** The play-area polygon uses a custom transverse Mercator projection centered on the metro (`+proj=tmerc +lat_0=33.85 +lon_0=-84.3`). Gwinnett crosses the UTM zone 16/17 line, so plain UTM won't do.
2. **Ingest.**

   | Source | What we take from it | License |
   |---|---|---|
   | Geofabrik Georgia extract (OpenStreetMap) | Roads, rail, water, land use, POIs | ODbL |
   | **Overture Maps** (GeoParquet, via DuckDB) | Transportation, **buildings with heights**, places | ODbL / CDLA |
   | **USGS 3DEP** | 1 m elevation model and lidar point clouds (`s3://usgs-lidar-public`) | Public domain |
   | **Annual NLCD** | Land cover | Public domain |
   | Meta/WRI 1 m canopy height | Tree placement | Check the license |
   | NHD/3DHP and OSM water polygons | The Chattahoochee, Lanier, Allatoona | Public domain / ODbL |
   | MARTA, CobbLinc and Ride Gwinnett GTFS | Transit routes and stations | — |
   | GDOT road inventory | Fill in missing lane counts and speeds | Public agency data |
3. **Conflate.** OSM road geometry, with GDOT filling the gaps. Overture building footprints, with heights computed from **3DEP lidar** where missing (the top of the first returns minus bare earth, via PDAL). Everything goes into one GeoParquet/PostGIS store, which is also the ODbL derived database we publish.
4. **Warp.** Control points map real coordinates to game coordinates (see [Compression](#compression)), then the street network is thinned by class.
5. **Generate.**
   - **Roads**: road graph → junction polygons → lane meshes, crosswalks and signals. Road profiles are sampled from the elevation model and smoothed (limits on grade and curvature), and the terrain is cut and filled to fit. Bridges and overpasses come from OSM `layer` and `bridge` tags, with at least about 5 m clearance. The big interchanges are written by hand.
   - **Buildings**: footprints extruded with roof and facade styles chosen by land use, height and era. Hero landmarks are built by hand.
   - **Vegetation and props**: trees scattered from the canopy and land-cover data (Atlanta is a forest with a city in it), plus street furniture, signals and signs.
   - **AI data**: the lane graph for traffic, sidewalk and navmesh polygons for pedestrians, scenario points, popzones and jurisdiction polygons.
6. **Bake.** Tiles of about 256–512 m, each holding glTF + meshopt + KTX2 with LOD versions merged per material, collision boxes, and an AI-data blob. Far LODs are merged per area. Everything streams by distance.

Reference projects: Streets GL (MIT, a browser OSM renderer), OSM2World, TerraDrive (OSM → BeamNG), BeamNG Road Architect and OpenDRIVE (lane-level road modeling), CARLA's OSM import, OpenTwinMap.

---

## Performance and devices

- **Targets**: 60 fps on an M-series MacBook in Chrome and Safari, playable (30+ fps) on an iPhone 15 Pro, about 1,500 draw calls and about 3M visible triangles at most on High.
- **Graphics tiers** (Low, Medium, High, picked from the GPU, with a governor that steps down when the frame rate drops) also scale crowd and traffic density and LOD distances.
- **The look is GTA IV's, in Atlanta** (`src/client/render/look/`, [docs/graphics-plan.md](docs/graphics-plan.md) section 9): muted, hazy and grimy by day, a smoggy dusk, sodium-orange street lamps and lit windows at night, over procedural facades and worn roads, with a post pass for the grade and the bloom. Each tier has `fx` fields saying how much of it to spend (the table is in [docs/perf.md](docs/perf.md)). `?gfx=classic` is the old flat renderer; `&gfxoff=post,facade,surface,haze,lamps,bloom` turns parts off for an A/B test.
- **Draw calls**: BatchedMesh per material for tiles, InstancedMesh for props, peds and traffic, and impostors for far buildings.
- **Memory**: free CPU copies after GPU upload and stream tiles in and out. Phones get a lighter build (fewer pool lights, smaller tile radius, lower texture resolution). The iPhone's memory ceiling is the hard limit.
- **Perf and leak gates in CI** from the first playable build, ported from Skyrome's scripts (`perf-budget`, `soak`, `leaks`, `check:controls`).
- **Controls**: every mouse action also has a key (trackpad-friendly), with full gamepad support (driving needs analog triggers) and touch controls with a virtual stick, buttons and aim assist.

---

## Multiplayer (later)

The target is GTA Online-style **sessions of 8–32 players**, joined from a link.

- **Authoritative server** running the same simulation code headless. That means **the sim must be runtime-agnostic**: no DOM, no Node-only APIs, so it can run in a browser worker, a Cloudflare Durable Object or Node.
- **Own vehicle is client-authoritative with server sanity checks** (speed envelope, teleport distance, collision plausibility). The server owns damage, money, heat and rewards. Remote cars are dead-reckoned and interpolated about 100 ms behind. Full rollback of rigid-body cars isn't worth it in a city.
- **Interest management**: a 64–128 m cell grid, with update rates by distance (20 Hz near, 5 Hz mid, minimap-only far).
- **Transport**: **WebSocket first**, with binary delta snapshots; it's fine for 8–32 players and it's what Cloudflare supports. **WebTransport** (Baseline since Safari 26.4, March 2026; datagrams for state) stays behind the transport interface for later. It would need a non-Cloudflare host or a container.
- **Accounts and saves**: Cloudflare D1 (SQLite) for profiles, the money ledger and garages, with Turnstile on signup.

### Hosting on Cloudflare

The account already has **Workers Paid** and **R2 Paid** (both renew on 24 Oct). That covers everything in this table, including Durable Objects, D1 and Containers, with no new subscription needed.

| Piece | Cloudflare product | Notes |
|---|---|---|
| The game (HTML, JS, WASM) | Workers static assets (or Pages) | Free and unlimited requests. `_headers` sets COOP/COEP. 25 MiB per file. |
| Map tiles | **R2** | $0.015/GB-month, **free egress**, 10 GB free |
| Multiplayer rooms | **Durable Objects**, one per session | Run the TS + Rapier sim with a 20–30 Hz tick while players are connected, and stop the loop when the room empties so it can hibernate. WebSockets only. Watch the 128 MB memory limit. |
| Fallback game server | **Cloudflare Containers** (GA since April 2026) | Only if a room outgrows a Durable Object's CPU or memory. Has egress fees. |
| Accounts and saves | **D1** | Free tier is generous; Paid includes 50M writes a month |
| Staging and admin | Access (free for 50 users) | |

**Rough cost** for 10 rooms of 16 players running 24/7: **about $100 a month** (about $70 with input batched at 10 Hz). At a realistic few hours a day, it's **about $25–30 a month**. These are estimates from Cloudflare's published prices.

**Avoid lock-in**: the room code sits behind the same transport interface as single player, so it can move to a plain Node container (Hetzner, Colyseus Cloud) if Cloudflare stops fitting. Hathora shut down game hosting in May 2026, and Unity Multiplay was deprecated in April 2026.
- **Anti-cheat**: a browser client can't be trusted, so the server decides anything that matters. Add plausibility checks and rate limits, don't send what a player can't see, and make sessions private or invite-only by default.

---

## Names, brands and data licenses

**Geography stays real.** City, county and neighborhood names, streets, highways, rivers, lakes and mountains keep their real names.

**Parodied, GTA-style:**
- Stadium and venue sponsor names
- Corporate brands (soda, airline, hardware store, chicken sandwiches, waffle diner, the KFC on the Big Chicken; the giant chicken itself stays)
- Sports teams and logos
- Transit and toll brands (MARTA, Peach Pass)
- Malls and private attractions
- Radio stations
- The word "Olympic" (protected by US law)
- Real people and likenesses

**Police and other agencies** get fictional names and badges that echo the real ones ([draft list in CAST.md](docs/CAST.md#the-law-fictional-agencies-atlanta), e.g. Atlanta City Police, Georgia Highway Patrol). No state seals.

**Map data:**
- OpenStreetMap and Overture buildings and roads are **ODbL**. The game will show "© OpenStreetMap contributors" and the Overture, Microsoft, Esri and USGS credits on the map screen and in the credits.
- We'll publish the cleaned, conflated vector database under ODbL. The game's code and art stay under their own licenses.
- USGS and NLCD data are public domain.
- Get legal review before any commercial release.

---

## Roadmap

| Milestone | Goal | Done when |
|---|---|---|
| **M0: Research** | This README and the research notes | ✅ 14 Oct 2026 |
| **M1: Spike: drive a real block** | The pipeline bakes one 2 × 2 km tile of **Downtown centered on Five Points** (OSM + 3DEP + Overture; it takes in a stretch of the Connector and Centennial Park), with one drivable raycast car, the protagonist on foot, a chase camera, the sim in a worker and a loopback transport | 60 fps on the Mac, runs on the iPhone, controls check passes |
| **M2: Vertical slice: Intown and the river** | **Downtown, Midtown, the Connector, Old Fourth Ward and Inman Park on the way to Little Five Points and Candler Park, Buckhead, and west over the Chattahoochee to Vinings** (via West Paces Ferry and I-75). Streaming tiles, lane-graph traffic with signals, pedestrians with scenario points, carjacking, **driving and gunplay at equal polish** (cover, two or three weapons), heat 1–3 with the city police (and State Patrol on I-75/85), the first two fictional crews and their turf, one side activity (rideshare) | A 10-minute session of "steal a car, shoot your way out, lose them on the Connector" is fun |
| **M3: The metro** | The compression warp across the whole area, the interstates and hand-built interchanges, Cobb and Gwinnett districts, the airport, Stone Mountain and the lakes, jurisdictions (State Patrol PITs on interstates), time of day and weather | Drive Marietta Square → Downtown → Duluth with no seams |
| **M4: Sandbox depth** | Weapons and cover, the full dispatch ladder to 6 stars, side-activity backlog, economy, safehouses, garages, car mods, radio, random events | A player has reasons to stay for hours |
| **M5: Multiplayer alpha** | Headless server, accounts, 8–16 player sessions, interest management, server-owned police | Friends can cause trouble together from a link |

---

## Open questions

**Answered on 14 Oct 2026**:
- The title is Hood Sandbox, and the engine is built for many cities.
- The map edges: the airport, Stone Mountain and both lakes.
- A fixed protagonist.
- Shooting and driving get equal priority.
- Fictional gangs.
- No licensed music, and no Apple Music for now.
- Present day.
- The sensitive sites are on the map, handled with respect.
- The first slice is Downtown and the area around it.
- Cloudflare Workers Paid and R2 Paid are already on the account.

**Still open:**

1. **The cast.** Review the drafts in [docs/CAST.md](docs/CAST.md): Kudzu as the protagonist, the six crews, and the agency names.
2. **Go for M1?** M1 is the first technical spike: bake one Downtown tile from real data, drive a car, and walk the protagonist (a stand-in model at first).

## Planned repo layout

```
src/
  sim/          headless simulation: no three.js imports (runs in a worker, later on the server)
    vehicles/   raycast car, handling tables
    traffic/    lane graph, IDM/MOBIL, junctions, LOD sim
    peds/       population cycle, scenario points, reactions
    law/        crimes, witnesses, descriptions, heat, dispatch, jurisdictions
    economy/    ledger, shops, jobs
  client/       three.js rendering, camera, audio, UI, input (keyboard, gamepad, touch)
  world/        tile streaming, LOD, culling
  shared/       data tables (JSON), protocol, math, entity registry, transport interface
tools/pipeline/ OSM/Overture/3DEP → baked tiles (Node + DuckDB + GDAL + PDAL)
data/cities/
  atlanta/      the Atlanta city pack (see "City packs")
tools/blender/  Python scripts that build hero assets headless (blender -b --python)
server/         (M5) headless sim host
docs/           design docs and research
```

## Research

Full notes, with sources, from the research pass on 14 Oct 2026:

- [Tech stack: engines, WebGPU, physics, threads, formats](docs/research/tech-stack.md)
- [Map data: sources, licenses, scale, pipeline](docs/research/map-data.md)
- [Atlanta: districts, landmarks, police, culture, naming](docs/research/atlanta.md)
- [Gameplay systems and browser multiplayer](docs/research/systems-and-multiplayer.md)
- [Music, Cloudflare hosting and title check](docs/research/music-hosting-names.md)

Design drafts: [the cast: protagonist, crews and police agencies](docs/CAST.md).

## License

Code: [MIT](LICENSE). Map data © OpenStreetMap contributors (ODbL), Overture Maps Foundation and its sources; elevation and land-cover data from USGS (public domain).
