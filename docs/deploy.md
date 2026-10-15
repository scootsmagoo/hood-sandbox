# Deploying to Cloudflare

Hood Sandbox is served as a Cloudflare Workers static-assets site (no Worker script). The
build output in `dist/` goes up as-is, with the headers from `public/_headers`. Map tiles
are still served from the same site for this first device test; moving them to R2 is later work.

## What has to be true first

- **Tile baked.** `public/tiles/atlanta/m1-five-points/` is gitignored build output (about 9.7 MB).
  On a fresh clone, bake it first: `cd tools/pipeline && npm run bake`. Without it the game
  falls back to the procedural ground, which is useless for a device test. The deploy scripts
  refuse to run if `dist/tiles/atlanta/m1-five-points/tile.json` is missing.
- **Wrangler logged in.** `npx wrangler login` once per machine (opens a browser).
- **Account id.** If wrangler asks which account to use, or you have several, put
  `"account_id"` in `wrangler.jsonc` (the line is commented out there).

## Deploy

```sh
npm run deploy:dry   # build, check the tile is in dist/, wrangler deploy --dry-run (uploads nothing)
npm run deploy       # the same, then uploads
```

The Worker is named `hood-sandbox`, so the URL is:

```
https://hood-sandbox.<account>.workers.dev
```

`<account>` is your account's workers.dev subdomain (shown in the Cloudflare dashboard under
Workers & Pages). Wrangler prints the full URL when the deploy finishes.

## Update

Run `npm run deploy` again. Each deploy replaces the whole site. HTML is revalidated on every
load. Hashed bundles in `/assets/` are cached for a year. Tiles in `/tiles/` are not hashed, so
they revalidate on every load: an unchanged file costs a 304, and a re-baked tile shows up on the
next reload.

## Take it down

```sh
npx wrangler delete          # deletes the hood-sandbox Worker and its assets
```

Or delete it in the dashboard (Workers & Pages > hood-sandbox > Settings > Delete). The URL
stops working straight away.

## Privacy: who can reach it

The repo is public, and the workers.dev URL is reachable by anyone who has it. The game and
the baked tile (derived from OpenStreetMap and other open data) are both public. For a private
test, restrict the site with **Cloudflare Access**, which is free for up to 50 users:

1. Cloudflare dashboard > Zero Trust (create a team name if asked; the free plan is enough).
2. Access controls > Applications > Add an application > Self-hosted.
3. Application domain: `hood-sandbox.<account>.workers.dev`. Make sure the workers.dev
   subdomain is covered, which is the "Protect workers.dev" option in the Worker's settings
   under Domains & Routes if your dashboard shows it.
4. Add a policy: Action Allow, Include > Emails > your address and your iPhone's Apple ID
   address (the same one you sign in with on the phone).
5. Save. Opening the URL now asks for a one-time code sent to that email.

Access is a gate in front of the site, not a copy protection. Anyone who passes it can still
download the assets.

## Real-device test checklist

Source: `docs/perf.md` ("Only on the real devices") and the targets in `README.md`
(60 fps on an M-series Mac in Chrome and Safari; 30+ fps on an iPhone 15 Pro).

Quick-test URL parameters (add to the URL, combine with `&`):

| Parameter | Use |
|---|---|
| `?debug` | Turns on the debug HUD (fps, draw calls, triangles). It shows from the start with that parameter; the Backquote key toggles it on a keyboard, and the gamepad View button on a pad. |
| `?graphics=low` | Forces Low. The phone profile uses this; compare with the default (Medium on touch devices). |
| `?time=23:30` | Night. Also `?day=N` (0 = Sunday to 6 = Saturday) and `?time=HH:MM&day=N`. |
| `?ambient=0` | No sidewalk pedestrians, to isolate the cost of the traffic. |
| `?pedbudget=N` | Caps the pedestrians on screen at once. |
| `?traffic=0` | No ambient traffic. |

### On the Mac (Safari and Chrome)

- Open `?debug`, drive for 2 minutes in Downtown, and note the fps. Target: about 60.
- Safari: Develop menu (enable it in Settings > Advanced) > your iPhone or the Mac's page >
  Timelines > Graphics to see GPU time per frame. Safari has no GPU timer query, so the
  harness's GPU columns stay empty there.
- Chrome: DevTools > Performance and Memory. Check that `crossOriginIsolated` is `true` in the
  console (confirms the headers applied).
- Confirm the keyboard controls (WASD, mouse look, the bindings in `src/client/input/bindings.ts`).

### On the iPhone

- Open the URL in Safari (not an in-app browser, which may not isolate the page). Check that the
  game starts without the "Loading…" screen sticking.
- Frame rate: `?debug`, at default settings and at `?graphics=low`. Target: 30+ fps on an iPhone 15
  Pro; note the iPhone model and iOS version.
- Touch controls: steer, brake and shoot with real fingers. The emulated touch in the harness is
  not a real finger, so feel is only checked here. Check the iOS address bar and safe areas, and
  rotate the phone once.
- Audio: make sure sound starts after the first tap (audio unlock).
- Memory and crashes: drive for 10 minutes, mixing chases and gunfire. Watch for the tab
  reloading or going blank, which means Safari killed it.
- Thermal: after 10 minutes, note whether the fps drops over time and whether the phone is warm.
- Safari Web Inspector: connect the phone by cable, then on the Mac Develop > [iPhone] >
  the page. Use Timelines (JavaScript, Layout, Graphics), and the Memory tab (take a snapshot
  before and after 10 minutes of driving).
- Instruments (optional): Allocations and VM Tracker, for the total footprint. The JS heap is about
  30 MB; the tile's GPU buffers are a few tens of MB.
- Rapier's WASM compile time: note how long the first load takes on the phone (the WASM is 3.3 MB).

Report what you see with the model, iOS or macOS version, the URL parameters, and the fps numbers
from `?debug`.
