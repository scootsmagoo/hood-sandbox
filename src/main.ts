import { doorGeometry, type DoorGeometry } from './shared/doors';
import { HANDLING } from './shared/handling';
import { SIM_HZ } from './shared/protocol';
import { CameraRig } from './client/camera/CameraRig';
import { Game } from './client/Game';
import { AudioSystem } from './client/audio/AudioSystem';
import { GamepadSource } from './client/input/gamepad';
import { TouchControls } from './client/input/touch';
import { NetSystem } from './client/net/NetSystem';
import { Atmosphere } from './client/render/Atmosphere';
import { lookMode } from './client/graphics';
import { installLook } from './client/render/look';
import { clockFromParams } from './client/render/timeOfDay';
import { EntityViews } from './client/render/EntityViews';
import { loadCarAssets } from './client/render/carAssets';
import { loadCharacterAssets } from './client/render/chars/characterAssets';
import { loadCollisionDebug } from './client/render/CollisionDebug';
import { loadLandmarks } from './client/render/Landmarks';
import { loadScenarioProps } from './client/render/ScenarioProps';
import { loadSignalHeads } from './client/render/SignalHeads';
import { createTransport } from './client/transport/createTransport';
import { Hud } from './client/ui/Hud';
import { GunHud } from './client/ui/GunHud';
import { LawHud } from './client/ui/LawHud';
import { GunFx } from './client/render/GunFx';
import { AimSystem } from './client/weapons/AimSystem';
import { Minimap } from './client/ui/minimap';
import { StreetName } from './client/ui/streetName';
import { createWorldView, type WorldView } from './world/WorldView';

declare global {
  interface Window {
    /** Test and debugging hooks. */
    __hood?: { game: Game; ready: boolean; error?: string; sim: typeof SIM_HZ; world?: WorldView; reloadWorld?: () => Promise<void>; doors: (typeId: string) => DoorGeometry; stream?: import('./world/stream/WorldStream').WorldStream };
  }
}

const DEFAULT_TILE = 'tiles/atlanta/m1-five-points/';

async function main() {
  const params = new URLSearchParams(location.search);
  const boot = document.getElementById('boot')!;
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hooks: NonNullable<Window['__hood']> = {
    game: undefined as unknown as Game,
    ready: false,
    sim: SIM_HZ,
    doors: (typeId) => doorGeometry(HANDLING[typeId] ?? HANDLING.sedan),
  };
  window.__hood = hooks;
  try {
    const game = new Game(canvas, params);
    hooks.game = game;

    // The sim (in a worker) fetches the tile itself, so give it an absolute URL.
    const tileParam = params.get('tile');
    // ?tiles=fixture: the streamed test city; ?tiles=tiles/atlanta/m2/: a baked city's index (docs/contracts/city-tiles.md)
    const tilesParam = params.get('tiles');
    const cityUrl = tilesParam ? (tilesParam.startsWith('fixture') ? tilesParam : new URL(tilesParam.endsWith('.json') || tilesParam.endsWith('/') ? tilesParam : `${tilesParam}/`, document.baseURI).href) : null;
    const tileBase = cityUrl || tileParam === 'none' ? null : new URL(tileParam ?? DEFAULT_TILE, document.baseURI).href;
    const seed = Number(params.get('seed') ?? 1) || 1;

    // The car models (public/assets/vehicles, built by `npm run assets`) load while the sim starts; a car whose model fails stays a box.
    const carAssets = loadCarAssets();
    // The people (public/assets/characters): skinned figures, or the box ones when they are missing or ?peds=box.
    const charAssets = loadCharacterAssets();
    const transport = await createTransport(params);
    game.transport = transport;
    boot.textContent = 'Loading the map…';
    game.ready = await transport.start({
      seed,
      tileBaseUrl: tileBase,
      cityUrl,
      streamTier: game.tier.name,
      vehicleType: params.get('car') ?? undefined,
      // ?start=car: beside an empty car; ?start=jack: beside the driver's door; default: on the sidewalk.
      start: ['car', 'jack'].includes(params.get('start') ?? '') ? (params.get('start') as 'car' | 'jack') : undefined,
      driverMood: ['flee', 'fight'].includes(params.get('driver') ?? '') ? (params.get('driver') as 'flee' | 'fight') : undefined,
      parkedCars: params.has('parked') ? Math.max(0, Math.min(20, Number(params.get('parked')) || 0)) : undefined,
      bystanders: params.has('peds') && params.get('peds') !== 'box' ? Math.max(0, Math.min(12, Number(params.get('peds')) || 0)) : undefined,
      armour: params.has('armour') ? Math.max(0, Math.min(100, Number(params.get('armour')) || 0)) : undefined,
      // ?weapons=all: every gun; ?weapons=none: unarmed. Default: a pistol and some rounds.
      weapons: ['all', 'none'].includes(params.get('weapons') ?? '') ? (params.get('weapons') as 'all' | 'none') : undefined,
      clock: clockFromParams(params),
      // ?traffic=0 turns the ambient cars off; ?traffic=0.5 scales the tier's density.
      traffic: params.has('traffic') ? Math.max(0, Math.min(1, Number(params.get('traffic')) || 0)) : game.tier.trafficDensity,
      // ?ambient=0 turns the pedestrians of the sidewalks off; ?pedbudget=N overrides the tier's number.
      ambientPeds: params.get('ambient') !== '0',
      pedBudget: params.has('pedbudget') ? Math.max(0, Math.min(150, Number(params.get('pedbudget')) || 0)) : game.tier.pedBudget,
      autoRun: true,
    });

    const city = game.ready.city ?? null;
    if (!city) {
      let world = await createWorldView(game.ready, tileBase, seed);
      game.scene.add(world.root);
      game.addSystem({ name: 'world', priority: 200, lateUpdate: () => world.update(game.camera, game.tier.lodScale) });
      hooks.world = world;
      // The leak harness (scripts/leaks.mjs) drops the drawn world and builds it again from the files.
      hooks.reloadWorld = async () => {
        world.dispose();
        world = await createWorldView(game.ready, tileBase, seed);
        game.scene.add(world.root);
        hooks.world = world;
      };
    }

    // The governor steps the tier down when the frame rate drops; fewer people on the street then too.
    game.onTierChange((t) => {
      if (!params.has('pedbudget')) transport.config?.({ pedBudget: t.pedBudget });
      if (!params.has('traffic')) transport.config?.({ traffic: t.trafficDensity });
    });
    if (!city) {
      const props = await loadScenarioProps(game.scene, tileBase);
      if (props) game.addSystem(props);
      const heads = await loadSignalHeads(game, tileBase, game.ready.tile.lanes);
      if (heads) game.addSystem(heads);
    }
    game.addSystem(new NetSystem(game));
    // ?debug=collision draws the wireframes of everything the sim collides with.
    if (params.get('debug') === 'collision') {
      const dbg = await loadCollisionDebug(game, tileBase, game.ready.tile);
      if (dbg) game.addSystem(dbg);
    }
    game.addSystem(new AimSystem(game));
    await carAssets;
    await charAssets;
    game.addSystem(new EntityViews(game));
    game.addSystem(new GunFx(game));
    game.addSystem(new CameraRig(game));
    game.addSystem(new Atmosphere(game));
    // The GTA IV look (src/client/render/look/): the default. ?gfx=classic is the old flat renderer; &gfxoff=post,facade,surface,haze,lamps,bloom switches parts off for A/B.
    const look = lookMode(params) === 'gta4' ? installLook(game, tileBase) : null;
    // The hero landmark models (public/assets/landmarks) stand where the bake took the generic buildings out; after the look, so the facades get its shaders.
    if (params.get('landmarks') !== 'off') {
      const landmarks = await loadLandmarks(game, tileBase);
      if (landmarks) game.addSystem(landmarks.system);
    }
    game.addSystem(new Hud(game));
    game.addSystem(new GunHud(game));
    game.addSystem(new LawHud(game));
    const minimap = game.addSystem(new Minimap(game, tileBase));
    const streetName = game.addSystem(new StreetName(game, tileBase));
    if (city) {
      // the streamed city's tiles, drawn round the camera (loaded lazily: the default single-tile build does not carry it)
      const { WorldStream } = await import('./world/stream/WorldStream');
      const base = cityUrl!.startsWith('fixture') ? cityUrl! : new URL('.', cityUrl!.endsWith('.json') ? cityUrl! : `${cityUrl}index.json`).href;
      let stream = game.addSystem(new WorldStream(game, city, base, { look, minimap, streetName }));
      hooks.stream = stream;
      hooks.reloadWorld = async () => {
        stream.dispose();
        stream = new WorldStream(game, city, base, { look, minimap, streetName });
        hooks.stream = stream;
        // (the old one is still in the system list, disposed: it does nothing)
        game.addSystem(stream);
      };
    }
    game.addSystem(new AudioSystem(game));
    game.gamepad = new GamepadSource();
    game.input.addSource(game.gamepad);
    game.touch = new TouchControls(document.body, game.input);
    game.input.addSource(game.touch);

    game.start();
    // Wait for the first interpolated frame before taking the loading cover off.
    await new Promise<void>((resolve) => {
      const check = () => (game.view.controlled ? resolve() : requestAnimationFrame(check));
      check();
    });
    boot.classList.add('done');
    hooks.ready = true;
  } catch (e) {
    console.error(e);
    hooks.error = e instanceof Error ? e.message : String(e);
    boot.className = 'error';
    boot.textContent = `Could not start\n\n${hooks.error}`;
  }
}

void main();
