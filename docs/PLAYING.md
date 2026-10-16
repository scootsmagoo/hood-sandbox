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
| H or ? | Show or hide the help |
| ` (backtick) | Show or hide the debug readout |

Esc lets go of the mouse, as the browser does.

### One-button mouse (Magic Mouse, trackpad)

A one-button mouse cannot hold the aim button and click to fire at the same time. So the game has an aim toggle.

- **Tap Z, or Ctrl-click, to toggle aim.** The aim stays up until the next tap. A press held longer than 0.3 seconds works as hold-to-aim.
- **Click to fire.** Firing alone shoots from the hip, with the camera left as it is.
- **Press T to reload.**

Ctrl-click is the Mac's right click.

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
| View | Debug readout |
| Menu | Help |

### Touch

- **Left thumb:** a floating stick. It moves you on foot, and steers and throttles in a car.
- **Right side:** drag to look.
- **Buttons:** Jump, Run, Get in, Reset and Punch.
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
- **A police chase.** Do something in front of a witness, such as a carjack or a shot. Watch how the police response climbs. Break line of sight to lose them. A minor offense on a quiet city street won't start a chase on its own.
- **Night driving.** Start with `?time=22:00&timescale=0`, or wait for dusk. Drive the streets around Five Points and Centennial Park.
- **The landmarks.** Walk up to Silverline Stadium, the Georgia State Capitol, the Georgia Aquarium, the Fountain of Rings or Trustline Plaza. The street-name label shows a landmark's name as you get close. Use `?landmarks=off` to see the city without the models.
