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
import { clockFromParams } from './client/render/timeOfDay';
import { EntityViews } from './client/render/EntityViews';
import { loadScenarioProps } from './client/render/ScenarioProps';
import { loadSignalHeads } from './client/render/SignalHeads';
import { createTransport } from './client/transport/createTransport';
import { Hud } from './client/ui/Hud';
import { GunHud } from './client/ui/GunHud';
import { GunFx } from './client/render/GunFx';
import { AimSystem } from './client/weapons/AimSystem';
import { Minimap } from './client/ui/minimap';
import { createWorldView, type WorldView } from './world/WorldView';

declare global {
  interface Window {
    /** Test and debugging hooks. */
    __hood?: { game: Game; ready: boolean; error?: string; sim: typeof SIM_HZ; world?: WorldView; reloadWorld?: () => Promise<void>; doors: (typeId: string) => DoorGeometry };
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
    const tileBase = tileParam === 'none' ? null : new URL(tileParam ?? DEFAULT_TILE, document.baseURI).href;
    const seed = Number(params.get('seed') ?? 1) || 1;

    const transport = await createTransport(params);
    game.transport = transport;
    boot.textContent = 'Loading the map…';
    game.ready = await transport.start({
      seed,
      tileBaseUrl: tileBase,
      vehicleType: params.get('car') ?? undefined,
      // ?start=car: beside an empty car; ?start=jack: beside the driver's door; default: on the sidewalk.
      start: ['car', 'jack'].includes(params.get('start') ?? '') ? (params.get('start') as 'car' | 'jack') : undefined,
      driverMood: ['flee', 'fight'].includes(params.get('driver') ?? '') ? (params.get('driver') as 'flee' | 'fight') : undefined,
      parkedCars: params.has('parked') ? Math.max(0, Math.min(20, Number(params.get('parked')) || 0)) : undefined,
      bystanders: params.has('peds') ? Math.max(0, Math.min(12, Number(params.get('peds')) || 0)) : undefined,
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

    // The governor steps the tier down when the frame rate drops; fewer people on the street then too.
    game.onTierChange((t) => {
      if (!params.has('pedbudget')) transport.config?.({ pedBudget: t.pedBudget });
      if (!params.has('traffic')) transport.config?.({ traffic: t.trafficDensity });
    });
    const props = await loadScenarioProps(game.scene, tileBase);
    if (props) game.addSystem(props);
    const heads = await loadSignalHeads(game, tileBase, game.ready.tile.lanes);
    if (heads) game.addSystem(heads);
    game.addSystem(new NetSystem(game));
    game.addSystem(new AimSystem(game));
    game.addSystem(new EntityViews(game));
    game.addSystem(new GunFx(game));
    game.addSystem(new CameraRig(game));
    game.addSystem(new Atmosphere(game));
    game.addSystem(new Hud(game));
    game.addSystem(new GunHud(game));
    game.addSystem(new Minimap(game, tileBase));
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
