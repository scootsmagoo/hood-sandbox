# Physics: cars, people and how to tune them

The target is GTA IV's feel: heavy cars with momentum, soft suspension you can see working, grip that moves with the weight, slides that build and can be caught, crashes that land heavily, and people who are thrown by what hits them. Nothing holds a slide or a donut for the driver. Everything below is in `src/sim/vehicles/` (cars), `src/sim/ragdoll/` (bodies) and `src/sim/character/locomotion.ts` (on foot). The numbers are pinned by `tests/handling.test.ts` and `tests/ragdoll.test.ts`.

## The car model

A car is one Rapier rigid body (two convex hulls: a body with sloped bumpers, bonnet and boot, and a cabin with a raked windscreen and a roof narrower than the waist) on four ray-cast wheels. Each tick (`RaycastCar.step`):

1. **Suspension.** Each wheel's ray gives a suspension length. A spring (`frequencyHz`) and a damper (softer in bump than in rebound) give a normal load, applied at the hub. Anti-roll bars move load between the wheels of an axle. A stiff bump stop catches the last 4 cm.
2. **Tyres** (`tireForce` in `dynamics.ts`):
   - **Lateral:** the slip angle goes through a curve that rises to a peak at `peakSlipDeg`, then falls to `slideRatio` of the peak by `falloff` peak angles. Past the peak a slide feeds itself unless the driver catches it.
   - **Load sensitivity:** the friction coefficient falls as the load rises (`loadSensitivity`). Moving weight across an axle costs that axle grip, which is what makes lift-off oversteer and entry understeer happen without any special code.
   - **Longitudinal:** the engine and the brakes, limited by the same friction.
   - **Friction ellipse:** what driving or braking uses is taken from cornering (braking keeps an ABS-like floor). A driven wheel asked for more than it holds spins, pushes at the sliding value and keeps only `spinLateral` of its cornering grip (power oversteer).
   - **Handbrake:** locks the rear wheels. A locked tyre slides against its own velocity at `handbrakeGrip`, which swings the tail.
3. **Where the forces act.** Driving and braking forces act at the road, so the body dives and squats. Cornering forces act at the roll centre height (`rollCentreFront/Rear`), so the body rolls about it. The centre of mass sits about half a metre up.
4. **Steering.** The lock narrows with speed (`lockDeg` to `lockHighSpeedDeg` by `lockRefSpeed`). The rack slows with speed (`rateHighSpeed`). Steering into a slide can always reach past the speed lock toward the direction of travel. With the wheel let go, caster (`selfAlign`) trails the front wheels toward where the car is going, as a real rack does. This is the only help, and it is physical.
5. **Engine.** A low-gear push (`driveForce`), then constant power (`powerPerKg / speed`), then the limiter at `maxFlatVel`. There is also rolling resistance, engine braking and quadratic drag.
6. **Burnout.** Throttle with the brake (or the handbrake) while nearly stopped spins the rear tyres while the front brakes hold the car. With the wheel turned, the front brakes let go and the car swings round its front axle (a donut, driven by the spinning rear, not by an assist).
7. **Kerb trips.** A wheel sliding sideways faster than 2.2 m/s into a near-vertical face 9 cm above the road (a kerb) loses most of its sideways momentum at that low point (`TRIP`). This is how rollovers start: the rays alone would just climb the step.
8. **Crashes.** The hulls have restitution 0.32 with the max rule and friction 0.4 with the min rule (a flank or a belly slides). The measured coefficient of restitution against a wall is 0.13 to 0.28, and car to car about 0.15 to 0.2. Soft CCD (contacts predicted a step ahead) keeps fast cars out of thin walls. Hard CCD was dropped because it clamped the car's motion against ragdolls.

`dynamics.ts` holds the pure functions, with unit tests in `src/sim/vehicles/dynamics.test.ts`. `RaycastCar.ts` holds the per-tick integration.

### The numbers (this build; `tests/handling.test.ts` holds the envelopes)

| | Sedan | Coupe | Pickup |
|---|---|---|---|
| Mass | 1600 kg | 1380 kg | 2150 kg |
| 0 to 100 km/h | 9.0 s | 5.7 s | 11.6 s |
| Top speed | 166 km/h | 207 km/h | 138 km/h |
| 100 to 0 km/h (60 to 0 mph is about 0.93 of it) | 42.7 m | 37.9 m | 45.3 m |
| Lateral grip, steady skidpad (peak) | 0.83 g (0.89) | 0.94 g (0.98) | 0.72 g (0.77) |
| Body roll at the limit | 6.4° | 2.9° | 8.7° |
| Nose dive, full braking / squat, full throttle | 3.4° / 1.8° | 1.7° / 0.9° | 4.0° / 2.0° |
| Handbrake tap at 65 km/h: peak slide, back straight hands off | 5.9°, 0.77 s | 8.0°, 0.77 s | 4.4°, 0.58 s |
| Rollover: sideways into a 15 cm kerb | rolls from 12 to 13 m/s | 13 to 14 m/s | 8 to 9 m/s |
| Static stability factor (track / 2 h) | 1.47 | 1.80 | 1.26 |
| Crash restitution, wall at 50 / 80 km/h | 0.15 / 0.13 | 0.16 / 0.14 | 0.28 / 0.15 |

Behaviour the tests also pin:

- **Lift-off oversteer.** Lifting mid-corner grows the slide and the yaw rate, and unwinding the wheel catches it in under 1.5 s.
- **Entry understeer.** At 30 m/s with full lock the car turns at under 0.4 of what the wheels ask, sliding under 15°.
- **Weight transfer.** Braking hard puts more than 1.25 times the static load on the front tyres.
- **Handbrake.** A 0.6 s pull at 65 km/h brings the car round more than 45°, and counter-steer with some throttle drives out of it.
- **Keyboard.** Full throttle with the wheel hard over at 8 and 14 m/s slides under 25°, with no spin.
- **Motorway.** A lane change at 40 m/s slides under 6°.
- **T-bone.** A pickup hitting a sedan's flank at 72 km/h spins it; at 100 km/h it can roll it.

## Tuning a vehicle (`src/shared/data/handling.json`)

Entries other than `sedan` list only what they change. Change one thing at a time and run `npx vitest run tests/handling.test.ts`.

| To make it... | Change |
|---|---|
| heavier, lazier, more momentum | `mass`, and `inertiaScale` (x pitch, y yaw, z roll): above 1 rotates more slowly. Yaw inertia is the main brake on a spin. |
| roll and pitch more (wallow) | lower `suspension.frequencyHz` (and raise `travel` so the bump stops are not hit; set `wheels.mountY` so the ride height stays put: ride height = radius + travel x restRatio - 9.81 / (2 pi f)^2 - mountY); lower `rollCentreFront/Rear`; less `antiRollFront/Rear`; a higher `centreOfMass` y |
| float and bounce after bumps | lower `bumpDamping` and `reboundDamping` (rebound is usually about 1.5 times bump) |
| understeer more (safer) | more `antiRollFront` than rear, a higher `rearGrip`, a centre of mass further forward |
| oversteer, tail-happy | the opposite, a lower `slideRatio` (a slide past the peak feeds itself), a lower `spinLateral`, more `driveForce` (the rear spins up) |
| slides gradual and catchable | a higher `slideRatio` (0.85+), a wider `falloff`, a higher `selfAlign`, more yaw inertia |
| grip harder | `traction.mu` (lateral g is about mu, a little less after load sensitivity) |
| launch harder, top speed | `driveForce` (low-gear push, m/s^2), `powerPerKg` (W/kg at the wheels: 0 to 100 time), `maxFlatVel` and `drag` |
| stop shorter | `brakeForce` (demand), but the tyres cap it: mu x g is the most |
| steer slower or quicker | `rateDeg` and `returnRateDeg` (wheel degrees per second at a crawl), `rateHighSpeed` (the share left at speed), `lockHighSpeedDeg` |
| more or less likely to roll | the `centreOfMass` height against the track (the static stability factor), and `TRIP` in `RaycastCar.ts` for kerbs |
| bounce more off walls | `BODY.restitution` in `RaycastCar.ts` (applies to all cars) |

The pickup is the template for a truck: soft (0.9 Hz), lightly damped (0.25 and 0.4), a high centre of mass, a high yaw and roll inertia, and less grip. The coupe is the template for a sports car: stiffer (1.6 Hz), low, rear-biased, with a lower `slideRatio` and a lower `spinLateral`.

## Keyboard steering

The sim's rack slows with speed for everyone. On top of that, the client's keyboard ramp (`rampSteer` in `src/client/input/pure.ts`) winds a held key on more slowly at speed and stops short of full lock (70% at motorway speed). A tap at 140 km/h is then a lane change, not a spin, while full lock is still there when parking.

## The AI drivers

Traffic and police steer with pure pursuit and set their speed with a governor (`src/sim/police/pursuit.ts`). On the new cars the governor plans to use about half the grip in corners (`lateral` 4.2 m/s^2) and two thirds of the brakes (`brake` 5.5 m/s^2), so a heavy car that is late on the wheel still makes the turn. Four changes in `police/driving.ts`:

- A chaser closes on its target more gently (the target's speed plus 3.5 m/s plus 0.16 m/s per metre of gap, from plus 5 and 0.25), so it can shed the closing speed in time.
- From the ramming heat, a chaser closes up on its target instead of braking for it.
- A stuck car reverses with the wheel toward whatever its nose is against.
- A car after someone on foot drives straight at them from 45 m and slows from 26 m, so it does not circle the block.

PIT needed no change to `police.json`. `pitKick` adds the yaw a real bumper-to-quarter shove gives and leaves the rear tyres past their peak for 0.9 s.

## People: Euphoria-lite (`src/sim/ragdoll/`)

When someone is knocked down (by a car above 4 m/s closing speed, a punch, a knock-down bullet, a hard landing or a blast) or killed, their body becomes a **ragdoll**. It has 11 Rapier bodies (pelvis, torso, head, upper and lower arms, thighs, shins with feet; 75 kg) joined by ball joints at the waist, neck, shoulders and hips, and hinges with limits at the elbows and knees. The ball joints carry a little muscle tone, a soft motor toward standing: more when alive, almost none when dead. The parts collide with the world, props and cars, but not with each other.

- **Car hits.** The hit is detected before the physics step (`VehicleHitSystem`, priority 45). For each moving car, it predicts whether a person will meet the car's box within 2.5 ticks:
  - At walking pace (1.2 to 4 m/s closing) the person **stumbles**: shoved along and out of the car's way, with little control of their feet for half a second or so.
  - Faster than that, the bumper sweeps the legs (the parts take the car's velocity in shares falling from the shins to the head). The car's body then meets the ragdoll in the physics step: it folds onto the bonnet, slides up the windscreen, and goes over the roof if the car does not stop.
  - Damage follows the closing speed as before. A body already lying in the road is pushed by the car's body.
- **Blasts** throw people out at 4 to 15 m/s and up at 2 to 9 m/s, by distance (`blastThrow` in `combat/damage.ts`).
- **Bullets** that knock down or kill push the ragdoll along the shot. Hitscan hits the ragdoll's parts.
- **Impacts** after the first 0.4 s hurt when the pelvis or torso changes velocity by more than 13 m/s in a tick (landing from a throw, being run over).
- **Getting up.** Once the trunk and thighs have been still for 0.5 s and the knock-down time is nearly over, the pose blends from lying to standing over 1.1 s (the hips rise late), and the capsule comes back. The dead stay down.
- **Budget.** At most 6 ragdolls have bodies at once. A body at rest freezes (bodies removed, pose kept). When a seventh is needed, the oldest freezes. A frozen body that a car reaches wakes up again. Respawns and despawns release their ragdolls.
- **Snapshot.** Ragdoll records follow the entity records: the ped id, the pelvis centre and 11 packed rotations, 26 words each, at most 16 records (active ones first, then the most recently frozen). `PedFlag.Ragdoll` marks the ped. The client rebuilds the part positions from the joints and draws the block figure's parts there (`src/client/render/RagdollFigures.ts`, one instanced mesh per part kind). It keeps the last pose for a body whose record has dropped out.
- **Determinism.** Everything is created and stepped in sim ticks, in creation order. `tests/ragdoll.test.ts` replays a crash with a pedestrian thrown to identical snapshot bytes.

### How far people are thrown (sedan; braking hard at the hit)

| Speed at the hit | Thrown (pelvis at rest from the point of impact) | Peak pelvis height | Outcome |
|---|---|---|---|
| 30 km/h | 4.7 m | 1.0 m (onto the bonnet) | down, 46 health left |
| 50 km/h | 13.2 m | 1.1 m | dead |
| 80 km/h | 31.0 m | 1.5 m (up the windscreen) | dead |

These are close to the forward-projection distances in pedestrian accident studies (about 5, 15 and 35 m). A car that does not brake carries the body on the bonnet much further, or throws it over the roof.

### Cost

On the baked Five Points tile with traffic at 0.75 and 40 pedestrians (Node, 20 s each), the sim step is 1.14 ms mean (1.50 p95) without ragdolls and 1.42 ms (1.84 p95) with 6 ragdolls kept active, so each active ragdoll costs about 0.05 ms a tick. A frozen body costs nothing. `npm run leaks -- --phases ragdoll --query transport=loopback` throws and removes eight people 20 times: the bodies and joints and the client's pooled figures stay flat.

## On foot

The top speeds are unchanged: walk 1.5, jog 3.3, sprint 5.5 m/s. The weight comes from the rates in `locomotion.ts`:

- **Acceleration** is 15 m/s^2, so a jog is reached in about a quarter of a second.
- **Stopping** is 30 m/s^2 from a walk, easing to 13 m/s^2 from a sprint, so a sprint ends in a slide of about a metre.
- **Turning** toward the movement direction is 9 rad/s.
- **Stumbles.** A sprinting player who runs into a pedestrian staggers them (`BalanceSystem`), and so does a car's nudge.

## What still differs from GTA IV

- **No real wheel spin model.** A wheel either grips or spins at the sliding value; there is no wheel speed or slip ratio. Launch wheelspin and the burnout are approximated.
- **No gearbox.** The engine is a push, then constant power. There are no shift pauses and no rev sound to follow.
- **Kerbs.** Tripping is a sideways impulse at a fixed height, not a tyre's sidewall. A wheel driven straight at a kerb climbs it like a ray does.
- **No body deformation in the physics.** Dents are drawn, but the hull does not change shape, and nothing breaks off.
- **The ragdoll has no active balance controller.** The stumble is a scripted stagger with reduced control, and the muscle tone is a soft motor. A body does not throw out its arms to break a fall or try to stand up while sliding.
- **AI and physics.** The AI drives within its governor and never uses a slide. Police PIT still adds a scripted yaw kick on contact.
