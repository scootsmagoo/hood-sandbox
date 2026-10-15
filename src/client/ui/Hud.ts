/**
 * The heads-up display: frames per second, speed, whether the player is on foot or in a car,
 * context prompts, map attribution, and a debug panel.
 */
import { atDriverDoor } from '../../shared/doors';
import { HANDLING } from '../../shared/handling';
import { rotateVecInv } from '../../shared/math';
import { PedFlag, VehicleFlag } from '../../shared/snapshot';
import type { SimEvent } from '../../shared/protocol';
import { HeatPhase, Overlay } from '../../shared/snapshot';
import type { Game, System } from '../Game';
import { codeLabel } from '../input/bindings';
import { padButtonFor, padButtonLabel, type GamepadSource } from '../input/gamepad';
import type { TouchControls } from '../input/touch';
import { formatClock } from '../render/timeOfDay';
import { radarTop } from './minimap';

const MPS_TO_MPH = 2.23694;
/** Same rules as the sim's enter and exit (systems.ts). */
const ENTER_RANGE = 2.2;
const EXIT_MAX_SPEED = 9;

declare module '../Game' {
  interface Game {
    hud: Hud;
    gamepad?: GamepadSource;
    touch?: TouchControls;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

/** A five-pointed star in a 24 x 24 box. */
const STAR_POINTS = '12,1.5 15,8.6 22.5,9.2 16.8,14.1 18.6,21.5 12,17.6 5.4,21.5 7.2,14.1 1.5,9.2 9,8.6';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Compass point of a direction in game axes (north is -Z). */
export function compassPoint(dx: number, dz: number): string {
  const a = Math.atan2(dx, -dz); // 0 north, PI/2 east
  return COMPASS[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

export class Hud implements System {
  readonly name = 'hud';
  readonly priority = 200;
  private root: HTMLElement;
  private fpsEl: HTMLElement;
  private clockEl: HTMLElement;
  private speedNum: HTMLElement;
  private speedUnit: HTMLElement;
  private stateEl: HTMLElement;
  private promptEl: HTMLElement;
  private toastEl: HTMLElement;
  private helpEl: HTMLElement;
  private attribEl: HTMLElement;
  private debugEl: HTMLElement;
  private healthEl: HTMLElement;
  private healthFill: HTMLElement;
  private armourEl: HTMLElement;
  private armourFill: HTMLElement;
  private starsEl: HTMLElement;
  private starEls: SVGElement[] = [];
  private coolFill: HTMLElement;
  private overlayEl: HTMLElement;
  private overlayText: HTMLElement;
  private toastUntil = 0;
  private helpUntil = performance.now() + 25000;
  private debugOn: boolean;
  private slow = 0;
  private cache = { speed: '', state: '', prompt: '', fps: '', health: '', armour: '', stars: '', cool: '', overlay: '', clock: '' };

  constructor(private readonly game: Game) {
    game.hud = this;
    this.root = document.getElementById('hud') ?? document.body;
    this.root.textContent = '';
    this.debugOn = game.params.has('debug');
    this.fpsEl = el('div', 'hud-fps', this.root);
    // The game clock, top centre: "Wed 14:00".
    this.clockEl = el('div', 'hud-clock', this.root);
    Object.assign(this.clockEl.style, { position: 'absolute', top: '10px', left: '50%', transform: 'translateX(-50%)', color: 'var(--dim)', fontVariantNumeric: 'tabular-nums', fontSize: '13px', letterSpacing: '0.04em' });
    const speed = el('div', 'hud-speed', this.root);
    this.speedNum = el('span', 'num', speed, '0');
    this.speedUnit = el('span', 'unit', speed, 'mph');
    this.stateEl = el('div', 'hud-state', this.root);
    this.promptEl = el('div', 'hud-prompt', this.root);
    // Health and armour, bottom left.
    const bars = el('div', 'hud-bars', this.root);
    // The radar (minimap.ts) sits at the bottom left: the bars stand above it.
    bars.style.bottom = `${radarTop()}px`;
    this.armourEl = el('div', 'bar armour', bars);
    this.armourFill = el('div', 'fill', this.armourEl);
    this.healthEl = el('div', 'bar health', bars);
    this.healthFill = el('div', 'fill', this.healthEl);
    // Stars, top right: hollow while reported, solid when seen, flashing when lost.
    this.starsEl = el('div', 'hud-stars', this.root);
    for (let i = 0; i < 6; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('class', 'star');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', STAR_POINTS);
      svg.appendChild(poly);
      this.starsEl.appendChild(svg);
      this.starEls.push(svg);
    }
    this.coolFill = el('div', 'cool', this.starsEl);
    this.overlayEl = el('div', 'hud-overlay', this.root);
    this.overlayText = el('div', 'text', this.overlayEl);
    this.toastEl = el('div', 'hud-toast', this.root);
    this.helpEl = el('div', 'hud-help', this.root);
    this.helpEl.style.bottom = `${radarTop() + 42}px`;
    this.attribEl = el('div', 'hud-attrib', this.root);
    this.debugEl = el('pre', 'hud-debug', this.root);
    this.debugEl.hidden = !this.debugOn;
    this.renderHelp();
    this.renderAttribution();
    game.onSimEvent((e) => this.onEvent(e));
    game.input.onDeviceChange(() => this.renderHelp());
  }

  private renderAttribution() {
    const { tileSource, tile, fallbackReason } = this.game.ready;
    this.attribEl.textContent = '';
    if (tileSource === 'baked') {
      this.attribEl.textContent = tile.attribution.join('  ·  ');
    } else {
      this.attribEl.textContent = 'Procedural test ground';
      if (fallbackReason) this.attribEl.title = fallbackReason;
    }
  }

  private key(action: Parameters<Game['input']['down']>[0]): string {
    const { input } = this.game;
    if (input.device === 'gamepad') {
      const b = padButtonFor(action);
      if (b !== undefined) return padButtonLabel(b, this.game.gamepad?.family ?? 'generic');
    }
    if (input.device === 'touch') return '';
    return codeLabel(input.bindings[action][0] ?? '?');
  }

  private renderHelp() {
    const k = (a: Parameters<Game['input']['down']>[0]) => this.key(a);
    const pad = this.game.input.device === 'gamepad';
    const touch = this.game.input.device === 'touch';
    const rows: [string, string][] = touch
      ? [['Left thumb', 'Move, steer and throttle'], ['Right side', 'Drag to look'], ['Buttons', 'Jump, run, get in, punch, reset'], ['Aim / Fire', 'Hold Aim, tap Fire; Cover, Reload, Gun to change weapon']]
      : pad
        ? [['Left stick', 'Move / steer'], ['RT / LT', 'Throttle / brake'], ['Right stick', 'Look'], [k('jump'), 'Jump'], [k('handbrake'), 'Handbrake'], [k('interact'), 'Get in / out'], [k('melee'), 'Punch (reload while aiming)'], [k('reset'), 'Reset car'], ['LT / RT', 'Aim / fire (RB / X from a car)'], ['D-pad left, right', 'Change weapon'], [k('cover'), 'Take cover']]
        : [
            ['W A S D', 'Move, or throttle, brake and steer'],
            ['Shift', 'Sprint'],
            [`${k('jump')}`, 'Jump, or handbrake'],
            [k('interact'), 'Get in or out; at a driver\'s door, carjack'],
            [k('melee'), 'Punch (on foot)'],
            [`${k('aim')} / ${k('fire')}`, 'Aim / fire (a pistol or SMG works from a car)'],
            [`1 - 4, ${k('weaponNext')} ${k('weaponPrev')}, scroll`, 'Change weapon (scroll while aiming)'],
            [`${k('reload')} / ${k('cover')}`, 'Reload / take cover at a wall'],
            ['Arrow keys / mouse', 'Look (click the game to capture the mouse)'],
            [k('lookBack'), 'Look behind (car)'],
            [`${k('toggleView')} / scroll`, 'Camera distance'],
            [k('reset'), 'Stand the car back up'],
            [`${k('debug')} / ${k('help')}`, 'Debug / this help'],
          ];
    this.helpEl.textContent = '';
    for (const [a, b] of rows) {
      const row = el('div', 'row', this.helpEl);
      el('b', '', row, a);
      el('span', '', row, b);
    }
  }

  private onEvent(e: SimEvent) {
    switch (e.type) {
      case 'vehicle:exit-denied':
        this.toast('Slow down to get out');
        break;
      case 'vehicle:reset':
        this.toast('Car reset');
        break;
      case 'carjack':
        this.toast('Carjacked', 2200);
        break;
      case 'ped:attack':
        if (e.targetId === this.game.view.ped?.id) this.toast('Hit');
        break;
      case 'witness:silenced':
        this.toast('Witness silenced', 1600);
        break;
      case 'crime:reported':
        if (!e.police) this.toast('Someone called it in', 1800);
        break;
      case 'vehicle:fire':
        if (e.vehicleId === this.game.view.vehicle?.id && this.game.view.inVehicle) this.toast('Car on fire. Get out!', 2600);
        break;
      case 'vehicle:engine-dead':
        if (e.vehicleId === this.game.view.vehicle?.id && this.game.view.inVehicle) this.toast('Engine dead', 2000);
        break;
      case 'heat:change':
        if (e.level === 0 && e.prevLevel > 0 && (e.reason === 'cooldown')) this.toast('Heat cleared', 2200);
        break;
      case 'entity:respawn':
        this.toast('Back to the spawn point');
        break;
      case 'weapon:empty':
        if (e.pedId === this.game.view.ped?.id) this.toast('Empty. Reload', 900);
        break;
    }
  }

  toast(text: string, ms = 1800) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    this.toastUntil = performance.now() + ms;
  }

  update(dt: number) {
    const g = this.game;
    const v = g.view;
    const now = performance.now();
    const input = g.input;
    if (input.pressed('debug')) {
      this.debugOn = !this.debugOn;
      this.debugEl.hidden = !this.debugOn;
    }
    if (input.pressed('help')) this.helpUntil = this.helpUntil > now ? 0 : now + 25000;
    this.helpEl.classList.toggle('on', this.helpUntil > now);
    if (this.toastUntil && now > this.toastUntil) {
      this.toastEl.classList.remove('on');
      this.toastUntil = 0;
    }

    const clock = g.clockView;
    const clockText = v.sample ? formatClock(clock.minutes, clock.day) : '';
    if (clockText !== this.cache.clock) this.clockEl.textContent = this.cache.clock = clockText;

    const st = v.controlled;
    if (!st) return;

    const fps = String(Math.round(g.fps));
    if (fps !== this.cache.fps) this.fpsEl.textContent = `${(this.cache.fps = fps)} fps`;

    const mph = Math.round(Math.hypot(st.vx, st.vz) * MPS_TO_MPH);
    const speed = String(mph);
    if (speed !== this.cache.speed) this.speedNum.textContent = this.cache.speed = speed;

    const drivenType = v.inVehicle ? (v.defs.get(st.id) as { typeId?: string } | undefined)?.typeId : undefined;
    const carName = HANDLING[drivenType ?? g.ready.vehicleType]?.name.replace(/ \(.*\)/, '') ?? 'car';
    const state = v.inVehicle ? `In car · ${carName}` : 'On foot';
    if (state !== this.cache.state) this.stateEl.textContent = this.cache.state = state;

    this.updateStatus();
    const prompt = this.promptText();
    if (prompt !== this.cache.prompt) {
      this.promptEl.textContent = this.cache.prompt = prompt;
      this.promptEl.classList.toggle('on', prompt !== '');
    }
    g.touch?.setUseLabel(v.inVehicle ? 'Get out' : prompt.includes('Carjack') ? 'Carjack' : 'Get in');

    this.slow += dt;
    if (this.debugOn && this.slow > 0.25) {
      this.slow = 0;
      this.renderDebug();
    }
  }

  /** Health and armour bars, the stars, and the WASTED or BUSTED screen. */
  private updateStatus() {
    const v = this.game.view;
    const hp = Math.max(0, Math.min(100, Math.round(v.health)));
    const ar = Math.max(0, Math.min(100, Math.round(v.armour)));
    const hpKey = String(hp);
    if (hpKey !== this.cache.health) {
      this.cache.health = hpKey;
      this.healthFill.style.width = `${hp}%`;
      this.healthEl.classList.toggle('low', hp > 0 && hp <= 30);
      this.healthEl.title = `Health ${hp}`;
    }
    const arKey = String(ar);
    if (arKey !== this.cache.armour) {
      this.cache.armour = arKey;
      this.armourFill.style.width = `${ar}%`;
      this.armourEl.classList.toggle('empty', ar === 0);
      this.armourEl.title = `Armour ${ar}`;
    }

    const phase = v.heatPhase === HeatPhase.Seen ? 'seen' : v.heatPhase === HeatPhase.Lost ? 'lost' : v.heatPhase === HeatPhase.Reported ? 'reported' : 'none';
    const starKey = `${v.heat}/${phase}`;
    if (starKey !== this.cache.stars) {
      this.cache.stars = starKey;
      this.starsEl.className = `hud-stars ${phase}${v.heat > 0 ? ' active' : ''}`;
      this.starEls.forEach((s, i) => s.classList.toggle('on', i < v.heat));
      this.starsEl.setAttribute('data-heat', String(v.heat));
      this.starsEl.setAttribute('data-phase', phase);
    }
    const cool = v.heat > 0 && phase !== 'seen' ? String(Math.round((1 - v.cooldown) * 50)) : '-';
    if (cool !== this.cache.cool) {
      this.cache.cool = cool;
      this.coolFill.style.width = cool === '-' ? '0%' : `${(1 - v.cooldown) * 100}%`;
    }

    const ov = v.overlay === Overlay.Wasted ? 'wasted' : v.overlay === Overlay.Busted ? 'busted' : '';
    if (ov !== this.cache.overlay) {
      this.cache.overlay = ov;
      this.overlayEl.className = `hud-overlay ${ov}${ov ? ' on' : ''}`;
      this.overlayText.textContent = ov === 'wasted' ? 'WASTED' : ov === 'busted' ? 'BUSTED' : '';
    }
    if (ov) {
      // Fades in over the first second and a half, and out as the respawn arrives.
      const t = v.overlayT;
      const fadeIn = Math.min(1, t / 1.5);
      const fadeOut = ov === 'wasted' ? Math.min(1, Math.max(0, (3.4 - t) / 0.5)) : Math.min(1, Math.max(0, (2.8 - t) / 0.5));
      this.overlayEl.style.setProperty('--ov', String(fadeIn));
      this.overlayEl.style.setProperty('--ov-out', String(fadeOut));
    }
  }

  private promptText(): string {
    const v = this.game.view;
    const ped = v.ped;
    const key = this.key('interact');
    const press = key ? `[${key}] ` : '';
    if (v.inVehicle) {
      const speed = Math.hypot(v.controlled!.vx, v.controlled!.vz);
      return speed > EXIT_MAX_SPEED ? '' : `${press}Get out`;
    }
    if (!ped || ped.flags & PedFlag.Busy) return '';
    // The nearest car in reach: an empty one to get into, or one with a driver whose door is within reach.
    let jack = false;
    let enter = false;
    let nearest = Infinity;
    for (const car of v.entities.values()) {
      if (car.kind !== 2) continue;
      const def = v.defs.get(car.id);
      const h = HANDLING[(def as { typeId?: string } | undefined)?.typeId ?? ''] ?? HANDLING.sedan;
      const l = rotateVecInv(car.q, ped.x - car.x, ped.y - car.y, ped.z - car.z);
      const occupied = (car.flags & VehicleFlag.Occupied) !== 0;
      if (occupied) {
        if (atDriverDoor(h, l.x, l.y, l.z)) jack = true;
        continue;
      }
      const half = h.chassis.halfExtents;
      const d = Math.hypot(Math.max(Math.abs(l.x) - half[0], 0), Math.max(Math.abs(l.z) - half[2], 0));
      if (Math.abs(l.y) < 2.2 && d < ENTER_RANGE) enter = true;
    }
    if (jack) return `${press}Carjack`;
    if (enter) return `${press}Get in`;
    const car = v.vehicle;
    if (!car) return '';
    const dist = Math.hypot(car.x - ped.x, car.z - ped.z);
    return dist > 12 ? `Car ${Math.round(dist)} m ${compassPoint(car.x - ped.x, car.z - ped.z)}` : '';
  }

  private renderDebug() {
    const g = this.game;
    const t = g.transport;
    const r = g.renderer.info.render;
    const s = t.stats;
    const lines = [
      `transport   ${t.kind}  ${t.shared ? 'SharedArrayBuffer' : 'postMessage'}  isolated=${typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated}`,
      `tile        ${g.ready.tileSource}  ${g.ready.tile.id}${g.ready.fallbackReason ? `\n            fallback: ${g.ready.fallbackReason}` : ''}`,
      `sim         tick ${g.view.tick}  step ${s ? s.stepMs.toFixed(2) : '-'} ms (max ${s ? s.stepMaxMs.toFixed(2) : '-'})`,
      `input lag   ${g.view.lagTicks} commands  interp clock ${g.net.interpolator.clockOffset.toFixed(0)} ms  buffer ${g.net.interpolator.size}`,
      `render      ${r.calls} draws  ${(r.triangles / 1000).toFixed(0)}k tris  ${g.frameMs.toFixed(1)} ms  tier ${g.tier.name}`,
      `gpu         ${g.gpuName}`,
    ];
    this.debugEl.textContent = lines.join('\n');
  }
}
