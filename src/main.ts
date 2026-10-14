import { doorGeometry, type DoorGeometry } from './shared/doors';
import { HANDLING } from './shared/handling';
import { SIM_HZ } from './shared/protocol';
import { CameraRig } from './client/camera/CameraRig';
import { Game } from './client/Game';
import { GamepadSource } from './client/input/gamepad';
import { TouchControls } from './client/input/touch';
import { NetSystem } from './client/net/NetSystem';
import { Atmosphere } from './client/render/Atmosphere';
import { EntityViews } from './client/render/EntityViews';
import { createTransport } from './client/transport/createTransport';
import { Hud } from './client/ui/Hud';
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

    game.addSystem(new NetSystem(game));
    game.addSystem(new EntityViews(game));
    game.addSystem(new CameraRig(game));
    game.addSystem(new Atmosphere(game));
    game.addSystem(new Hud(game));
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
