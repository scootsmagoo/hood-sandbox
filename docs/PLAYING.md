# Playing Hood Sandbox

**Play it at https://hood-sandbox.adam-021.workers.dev.** No install. Click the game to start. It runs in a desktop browser, with a gamepad, or on a phone or tablet.

The game is one 2 × 2 km tile of Downtown Atlanta around Five Points. You can walk, drive, carjack and shoot. The police respond to what you do.

To run it locally: `npm install && npm run dev`, then open http://127.0.0.1:5180.

## Controls

### Keyboard and mouse

| Key | What it does |
|---|---|
| W A S D | Move on foot. In a car: throttle, brake and steer |
| Shift | Sprint |
| Space | Jump. In a car: handbrake |
| E or F | Get in or out. At a driver's door, carjack |
| Q | Punch (on foot) |
| R | Stand the car back up (reset) |
| Right click or Z | Aim. Hold it, or tap it to keep the aim up until the next tap |
| Left click, G or Enter | Fire |
| T | Reload |
| X | Take cover at a wall |
| 1 to 4, [ and ] | Change weapon. The mouse wheel also changes weapon while aiming |
| Mouse, or arrow keys | Look. Click the game first to capture the mouse |
| C | Look behind (in a car) |
| V, or scroll | Camera distance |
| Tab or P | Open or close the map. Clicking the radar opens it too |
| H or ? | Show or hide the help |
| ` (backtick) | Show or hide the debug readout |

Esc lets go of the mouse, as the browser does.

### The map and the GPS

Open the map with **Tab** or **P**, or click the radar. It is a full-screen map of the city: the roads by class, the building footprints, the street names, the landmarks with their names, you, the police and the area they are searching. The game goes on behind it (the sim does not pause), but your controls are off and a car's handbrake is held, so it waits for you. The map closes by itself if you are wasted or busted.

**Set a waypoint by clicking the map** (or tapping it). The waypoint snaps to the nearest road. Click it again to clear it. Then:

- A **magenta route** follows the roads from where you are to the waypoint, on the radar and on the map. It drives over the lanes (it obeys one-ways and only makes turns the junction allows) when you are in a car, and over the pavements and crossings on foot. Get in or out of a car and it works the route out again.
- The **turn prompt** beside the radar says the next turn, how far away it is and how far is left ("Turn left onto Peachtree St NE, in 120 m, 2.1 km to go").
- A **beacon** of light, a pulsing ring and a turning diamond stand over the waypoint in the world, and stay visible at night and a long way off.
- If you stray from the route (about 25 m for 2 seconds), or turn back along it, the GPS finds a new one.
- Where the loaded map ends, the route runs to the edge of it and then straight on (a dashed line), and carries on from there as more of the city loads.
- You have arrived within about 15 m of the waypoint: it clears itself, with a chime. The last waypoint is remembered if you reload the page.

| In the map | What it does |
|---|---|
| Click, or tap | Set a waypoint there. Click the waypoint (or the spot it was set at) to clear it |
| Drag | Pan |
| Wheel, trackpad scroll or pinch | Zoom |
| Arrow keys or W A S D | Pan (hold Shift to go faster) |
| + and -, or E and Q | Zoom in and out |
| Enter or Space | Set or clear the waypoint at the cross in the middle of the map (the keyboard's cursor) |
| C or Home | Centre on you |
| Delete, Backspace or X | Clear the waypoint |
| Tab, P or Esc | Close |

The buttons at the top right zoom, centre on you and close; **Clear** at the bottom clears the waypoint.

### One-button mouse (Magic Mouse, trackpad)

A one-button mouse cannot hold the aim button and click to fire at the same time. So the game has an aim toggle.

- **Tap Z, or Ctrl-click, to toggle aim.** The aim stays up until the next tap. A press held longer than 0.3 seconds works as hold-to-aim.
- **Click to fire.** Firing alone shoots from the hip, with the camera left as it is.
- **Press T to reload.**

Ctrl-click is the Mac's right click.

**The map needs only a click.** Click the radar to open the map, click to set a waypoint, click the pin to clear it, click the X to close. Dragging pans and the wheel (or a scroll on the mouse's surface) zooms. The keys do the same (Tab, then the arrow keys and Enter), so the mouse is never required.

### Gamepad

The game uses the standard mapping (Xbox, PlayStation and most others).

| Button | What it does |
|---|---|
| Left stick | Move on foot. Steer in a car |
| Right stick | Look |
| RT | Fire on foot. Throttle in a car |
| LT | Aim on foot (hold). Brake in a car. Hold it and press X to reload |
| RB | Sprint on foot. Aim in a car, for a drive-by (fire with X) |
| L3 | Sprint |
| A | Jump |
| B | Take cover on foot. Handbrake in a car |
| X | Punch on foot. Fire from a car |
| Y | Get in or out. Carjack at a driver's door |
| LB | Stand the car back up |
| R3 | Look behind |
| D-pad up | Change camera view |
| D-pad left, right | Change weapon |
| D-pad down | Open the map |
| View | Debug readout |
| Menu | Help |

In the map: the **left stick** pans, the **right stick** or the **triggers** zoom, **A** sets or clears the waypoint at the cross in the middle, **X** clears it, **Y** centres on you, **B**, **View** and **Menu** close it.

### Touch

- **Left thumb:** a floating stick. It moves you on foot, and steers and throttles in a car.
- **Right side:** drag to look.
- **Buttons:** Jump, Run, Get in, Reset and Punch. **Map**, above the health bar at the left, opens the map: tap it to set a waypoint, drag to pan, pinch to zoom.
- **Gun buttons:** Fire (drag it to turn), Aim (a toggle), Reload, Gun (change weapon) and Cover.

## URL options

Add these to the address after a `?`. Join several with `&`.

| Option | What it does |
|---|---|
| `?time=HH:MM` | Start at this time of day, for example `?time=22:00` |
| `?day=0` to `?day=6` | Start on this day of the week |
| `?timescale=N` | Game minutes per real second (the default is 0.5). `?timescale=0` stops the clock |
| `?start=car` | Start beside an empty car |
| `?start=jack` | Start beside a driver's door, ready to carjack |
| `?weapons=all` | Start with every gun. `?weapons=none` starts unarmed. The default is a pistol and some rounds |
| `?graphics=low`, `medium` or `high` | Force a quality tier. This turns off the automatic step-down |
| `?gfx=classic` | The old flat renderer, for comparison. The default is the GTA IV look |
| `?debug` | Show the debug readout from the start |
| `?debug=collision` | Also draw the wireframes of everything the car and people collide with |
| `?tiles=tiles/atlanta/m2/` | Load the streamed multi-tile city from the M2 bake. The bake is still in progress, so the files may not be there yet. See [city-tiles.md](contracts/city-tiles.md) |
| `?landmarks=off` | Hide the hero landmark models |
| `?peds=box` | Draw people as plain boxes, not models |
| `?cars=box` | Draw cars as plain boxes, not models |

Example: `https://hood-sandbox.adam-021.workers.dev/?time=23:00&timescale=0` starts at 11 pm and keeps it there.

## What to try

- **A carjack.** Walk to a parked car at the curb. Stand at the driver's door and press E (or Y on a pad). Or start with `?start=jack`.
- **The GPS.** Open the map, click a street on the other side of Downtown and close the map. Walk, or drive: follow the magenta line, miss a turn on purpose and watch it find another way, and look for the beacon. Try a one-way street: the route goes the right way round.
- **A police chase.** Do something in front of a witness, such as a carjack or a shot. Watch how the police response climbs. Break line of sight to lose them. A minor offense on a quiet city street won't start a chase on its own.
- **Night driving.** Start with `?time=22:00&timescale=0`, or wait for dusk. Drive the streets around Five Points and Centennial Park.
- **The landmarks.** Walk up to Silverline Stadium, the Georgia State Capitol, the Georgia Aquarium, the Fountain of Rings or Trustline Plaza. The street-name label shows a landmark's name as you get close. Use `?landmarks=off` to see the city without the models.
