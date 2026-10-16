/**
 * The full-screen map: a dark north-up city map (roads by class, building footprints, street names, landmarks) with the player, the
 * police and the GPS route on it. Open it with Tab or P, a click on the radar, D-pad down, or the Map button on a touch screen.
 *
 *  - Click (or tap) a spot to set a waypoint; click it again to clear it. With the keyboard, a cursor sits in the middle of the map:
 *    Enter or Space sets or clears the waypoint there. One click is all a one-button mouse needs.
 *  - Drag to pan; wheel or pinch to zoom (a trackpad's two-finger scroll zooms smoothly); arrows or WASD pan, + - or Q E zoom,
 *    C centres on you; the pad's sticks pan and zoom, A sets, B closes; two fingers pinch on a touch screen.
 *  - The game goes on behind the map (the sim keeps running): the controls are off and a car's handbrake is held, so it waits.
 *
 * The map draws only while it is open, and only when something changed or a blip moves; the 3D view is not drawn meanwhile.
 */
import { yawOfQuat } from '../../../shared/math';
import { EntityKind } from '../../../shared/entities';
import { HeatPhase, PedFlag, VehicleFlag } from '../../../shared/snapshot';
import type { Game, System } from '../../Game';
import type { Navigator } from '../../nav/Navigator';
import { facingVector, flashPhase } from '../minimapMath';
import { mapLayers, type BigMapView } from './layers';
import { MapData, type MapTileGfx } from './mapData';
import {
  clampScale,
  formatScaleBar,
  keyPanSpeed,
  labelVisibleFrom,
  panBy,
  pinch,
  roadVisibleFrom,
  SCALE_START,
  scaleBar,
  screenToWorld,
  visibleRect,
  wheelFactor,
  worldToScreen,
  zoomAbout,
  type MapView,
} from './mapMath';
import { labelText, mapRoadStyle } from './mapRoads';

declare module '../../Game' {
  interface Game {
    bigMap?: BigMap;
  }
}

const BG = '#12151a';
const BUILDING = '#232932';
const CASING = '#0b0d10';
const LABEL = '#d6dce3';
const LABEL_HALO = 'rgba(10, 12, 15, 0.9)';
const GOLD = '#ffcf5a';
const POLICE_RED = '#ff3b30';
const POLICE_BLUE = '#3a7bff';
const SEARCH_FILL = 'rgba(255, 190, 60, 0.14)';
const SEARCH_LINE = 'rgba(255, 190, 60, 0.9)';
const EMPTY_CAR = 'rgba(170, 176, 184, 0.7)';
/** Pixels of slack before a click counts as a drag. */
const DRAG_SLOP = 6;
/** A click this close (px) to the waypoint's pin clears it. */
const PIN_HIT_PX = 20;
const CURSOR_HIT_PX = 24;
const MAX_LABELS = 160;

type Pt = { x: number; y: number };

const svgIcon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_CLOSE = svgIcon('M6 6l12 12M18 6L6 18');
const ICON_LOCATE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';

export class BigMap implements System {
  readonly name = 'bigmap';
  readonly priority = 120;
  readonly view: MapView = { cx: 0, cz: 0, scale: SCALE_START, w: 1, h: 1 };
  readonly data: MapData;
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly whereEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly wpEl: HTMLElement;
  private readonly wpName: HTMLElement;
  private readonly wpDist: HTMLElement;
  private readonly toastEl: HTMLElement;
  private dpr = 1;
  private openFlag = false;
  private dirty = true;
  private lastDraw = 0;
  private toastUntil = 0;
  private wasLocked = false;
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, Pt>();
  private dragFrom: Pt | null = null;
  private dragMoved = false;
  private pinchPrev: [Pt, Pt] | null = null;
  /** The crosshair in the middle (keyboard and pad); the mouse hides it. */
  private cursorMode = false;
  private lastRect = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  private lastRequest = 0;
  private readonly tmpTiles: MapTileGfx[] = [];
  private readonly pt: Pt = { x: 0, y: 0 };
  private readonly pt2: Pt = { x: 0, y: 0 };
  private readonly wpt = { x: 0, z: 0 };
  private readonly fwd = new Float64Array(2);
  private readonly padPrev = new Array<boolean>(16).fill(false);
  private readonly widthCache = new Map<string, number>();
  private readonly occ: Float32Array = new Float32Array(MAX_LABELS * 4 + 64 * 4);
  private nOcc = 0;
  private gestureScale = 1;
  private hoverName = '';
  private hoverAt = 0;
  private shownWhere = '';
  private shownHint = '';
  private shownWp = '';
  private disposed = false;
  private readonly bigView: BigMapView;
  private readonly off: Array<() => void> = [];

  constructor(
    private readonly game: Game,
    private readonly nav: Navigator,
  ) {
    game.bigMap = this;
    this.data = new MapData(nav.source, nav.core.roads, () => (this.dirty = true));
    const root = (this.root = document.createElement('div'));
    root.className = 'bigmap';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Map');
    const canvas = (this.canvas = document.createElement('canvas'));
    canvas.tabIndex = -1;
    this.ctx = canvas.getContext('2d')!;
    const top = document.createElement('div');
    top.className = 'bm-top';
    const title = document.createElement('div');
    title.className = 'bm-title';
    title.textContent = 'MAP';
    this.whereEl = document.createElement('div');
    this.whereEl.className = 'bm-where';
    const btns = document.createElement('div');
    btns.className = 'bm-btns';
    const mk = (label: string, html: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = html;
      // a map button must not start a drag, a click-through or a keyboard focus that Enter would then press again
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
        b.blur();
      });
      btns.appendChild(b);
      return b;
    };
    mk('Zoom in', '+', () => this.zoomKey(1.5));
    mk('Zoom out', '−', () => this.zoomKey(1 / 1.5));
    mk('Centre on me', ICON_LOCATE, () => this.centreOnPlayer());
    mk('Close the map', ICON_CLOSE, () => this.close());
    top.append(title, this.whereEl, btns);
    const bottom = document.createElement('div');
    bottom.className = 'bm-bottom';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'bm-hint';
    this.wpEl = document.createElement('div');
    this.wpEl.className = 'bm-wp';
    this.wpEl.hidden = true;
    const dot = document.createElement('span');
    dot.className = 'dot';
    this.wpName = document.createElement('span');
    this.wpName.className = 'name';
    this.wpDist = document.createElement('span');
    this.wpDist.className = 'dist';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.addEventListener('pointerdown', (e) => e.stopPropagation());
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      this.nav.clearWaypoint();
      this.toast('Waypoint cleared');
      clear.blur();
    });
    this.wpEl.append(dot, this.wpName, this.wpDist, clear);
    bottom.append(this.hintEl, this.wpEl);
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'bm-toast';
    root.append(canvas, top, bottom, this.toastEl);
    document.body.appendChild(root);

    this.bigView = {
      ctx: this.ctx,
      w: 1,
      h: 1,
      dpr: 1,
      scale: 1,
      cx: 0,
      cz: 0,
      minX: 0,
      minZ: 0,
      maxX: 0,
      maxZ: 0,
      time: 0,
      toScreen: (x, z, out) => worldToScreen(this.view, x, z, out),
      setWorld: () => {
        const s = this.view.scale * this.dpr;
        this.ctx.setTransform(s, 0, 0, s, this.dpr * (this.view.w / 2 - this.view.cx * this.view.scale), this.dpr * (this.view.h / 2 - this.view.cz * this.view.scale));
      },
      setScreen: () => this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0),
    };

    const on = <T extends Event>(el: Window | HTMLElement | Document, type: string, fn: (e: T) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on<PointerEvent>(canvas, 'pointerdown', (e) => this.pointerDown(e));
    on<PointerEvent>(canvas, 'pointermove', (e) => this.pointerMove(e));
    on<PointerEvent>(canvas, 'pointerup', (e) => this.pointerUp(e));
    on<PointerEvent>(canvas, 'pointercancel', (e) => this.pointerUp(e, true));
    on<WheelEvent>(canvas, 'wheel', (e) => this.wheel(e), { passive: false });
    on<Event>(canvas, 'contextmenu', (e) => e.preventDefault());
    on<KeyboardEvent>(window, 'keydown', (e) => this.keyDown(e), { capture: true });
    on<KeyboardEvent>(window, 'keyup', (e) => this.keys.delete(e.code));
    on<Event>(window, 'blur', () => this.keys.clear());
    on<Event>(window, 'resize', () => this.resize());
    // Safari's pinch is a gesture event, not a ctrl+wheel
    on<Event>(root, 'gesturestart', (e) => {
      e.preventDefault();
      this.gestureScale = 1;
    });
    on<Event>(root, 'gesturechange', (e) => {
      e.preventDefault();
      const ge = e as Event & { scale?: number; clientX?: number; clientY?: number };
      const scale = ge.scale ?? 1;
      if (scale > 0 && this.gestureScale > 0) zoomAbout(this.view, scale / this.gestureScale, ge.clientX ?? this.view.w / 2, ge.clientY ?? this.view.h / 2);
      this.gestureScale = scale;
      this.dirty = true;
    });
    on<Event>(root, 'gestureend', (e) => e.preventDefault());
    this.off.push(mapLayers(game).onInvalidate(() => (this.dirty = true)));
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  // ------------------------------------------------------------------ open and close

  open(by: 'key' | 'mouse' | 'pad' | 'touch' = 'mouse') {
    if (this.openFlag || this.disposed) return;
    const g = this.game;
    const st = g.view.controlled;
    if (!st || g.view.overlay) return;
    this.openFlag = true;
    this.wasLocked = g.input.pointerLocked;
    g.input.exitPointerLock();
    g.input.enabled = false;
    g.input.parkBrake = true;
    g.renderPaused = true;
    this.nav.mapOpen = true;
    this.nav.ensureLoaded();
    this.root.hidden = false;
    document.body.classList.add('map-open');
    this.resize();
    this.view.scale = clampScale(this.view.scale || SCALE_START);
    this.centreOnPlayer();
    // the cross in the middle of the map is for the keyboard and the pad; a mouse or a finger has its own pointer
    this.cursorMode = by === 'key' || by === 'pad';
    this.lastRequest = 0;
    this.dirty = true;
    this.canvas.focus({ preventScroll: true });
    this.renderHint();
  }

  close() {
    if (!this.openFlag) return;
    const g = this.game;
    this.openFlag = false;
    this.root.hidden = true;
    document.body.classList.remove('map-open');
    this.keys.clear();
    this.pointers.clear();
    this.dragFrom = null;
    this.pinchPrev = null;
    g.input.enabled = true;
    g.input.parkBrake = false;
    g.renderPaused = false;
    this.nav.mapOpen = false;
    if (this.wasLocked) g.input.requestPointerLock();
    // a key still down from the map (a pan, Enter) must not run on into the game
    this.canvas.classList.remove('grab');
  }

  toggle() {
    if (this.openFlag) this.close();
    else this.open(this.game.input.device === 'gamepad' ? 'pad' : this.game.input.device === 'touch' ? 'touch' : 'key');
  }

  centreOnPlayer() {
    const st = this.game.view.controlled;
    if (st) {
      this.view.cx = st.x;
      this.view.cz = st.z;
      this.dirty = true;
    }
  }

  private resize() {
    const w = Math.max(1, this.root.clientWidth || window.innerWidth);
    const h = Math.max(1, this.root.clientHeight || window.innerHeight);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.view.w = w;
    this.view.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.dirty = true;
  }

  // ------------------------------------------------------------------ input

  private zoomKey(factor: number) {
    zoomAbout(this.view, factor, this.view.w / 2, this.view.h / 2);
    this.dirty = true;
  }

  private keyDown(e: KeyboardEvent) {
    if (!this.openFlag) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Tab and P toggle through the game's own binding (Input), so they are not handled twice
    const code = e.code;
    const mine = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'KeyQ', 'KeyE', 'PageUp', 'PageDown', 'Enter', 'NumpadEnter', 'Space', 'KeyC', 'Home', 'Delete', 'Backspace', 'KeyX', 'Escape', 'ShiftLeft', 'ShiftRight'];
    if (!mine.includes(code)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    this.cursorMode = true;
    switch (code) {
      case 'Escape':
        this.close();
        return;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        this.toggleAtCursor();
        return;
      case 'KeyC':
      case 'Home':
        this.centreOnPlayer();
        return;
      case 'Delete':
      case 'Backspace':
      case 'KeyX':
        if (this.nav.core.waypoint) {
          this.nav.clearWaypoint();
          this.toast('Waypoint cleared');
        }
        return;
      case 'Equal':
      case 'NumpadAdd':
      case 'PageUp':
        this.zoomKey(1.35);
        return;
      case 'Minus':
      case 'NumpadSubtract':
      case 'PageDown':
        this.zoomKey(1 / 1.35);
        return;
      default:
        this.keys.add(code);
    }
    this.dirty = true;
  }

  private toggleAtCursor() {
    const v = this.view;
    const w = screenToWorld(v, v.w / 2, v.h / 2, this.wpt);
    this.setOrClear(w.x, w.z, CURSOR_HIT_PX / v.scale);
  }

  private setOrClear(x: number, z: number, nearM: number) {
    const r = this.nav.toggleWaypointAt(x, z, Math.max(10, Math.min(600, nearM)));
    const w = this.nav.core.waypoint;
    this.toast(r === 'cleared' ? 'Waypoint cleared' : w?.name ? `Waypoint set · ${w.name}` : 'Waypoint set');
    this.dirty = true;
  }

  private pointerDown(e: PointerEvent) {
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer (a test) has nothing to capture */
    }
    this.cursorMode = false;
    const p = { x: e.offsetX, y: e.offsetY };
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.dragFrom = { x: p.x, y: p.y };
      this.dragMoved = false;
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchPrev = [{ ...a }, { ...b }];
      this.dragMoved = true;
    }
  }

  private pointerMove(e: PointerEvent) {
    const cur = this.pointers.get(e.pointerId);
    const p = { x: e.offsetX, y: e.offsetY };
    if (!cur) {
      // hovering: the street under the pointer
      if (e.pointerType === 'mouse') this.hover(p.x, p.y);
      return;
    }
    const prev = { x: cur.x, y: cur.y };
    cur.x = p.x;
    cur.y = p.y;
    if (this.pointers.size >= 2 && this.pinchPrev) {
      const [a, b] = [...this.pointers.values()];
      const r = pinch(this.pinchPrev[0], this.pinchPrev[1], a, b);
      zoomAbout(this.view, r.factor, r.mx, r.my);
      panBy(this.view, r.dx, r.dy);
      this.pinchPrev = [{ ...a }, { ...b }];
      this.dirty = true;
      return;
    }
    if (this.dragFrom && !this.dragMoved && Math.hypot(p.x - this.dragFrom.x, p.y - this.dragFrom.y) > DRAG_SLOP) {
      this.dragMoved = true;
      this.canvas.classList.add('grab');
    }
    if (this.dragMoved) {
      panBy(this.view, p.x - prev.x, p.y - prev.y);
      this.dirty = true;
    }
  }

  private pointerUp(e: PointerEvent, cancelled = false) {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!had) return;
    this.canvas.classList.remove('grab');
    if (this.pointers.size < 2) this.pinchPrev = null;
    if (this.pointers.size === 0) {
      // a press that did not move is a click: set (or clear) the waypoint there
      if (!cancelled && !this.dragMoved && this.dragFrom && e.button <= 0) {
        const v = this.view;
        const w = screenToWorld(v, this.dragFrom.x, this.dragFrom.y, this.wpt);
        // a click on the waypoint's own pin clears it, however the map is zoomed
        this.setOrClear(w.x, w.z, PIN_HIT_PX / v.scale);
      }
      this.dragFrom = null;
      this.dragMoved = false;
    } else if (this.pointers.size === 1) {
      // one finger left after a pinch: it pans from where it is, and is not a click
      this.dragFrom = null;
      this.dragMoved = true;
    }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    this.cursorMode = false;
    zoomAbout(this.view, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.offsetX, e.offsetY);
    this.dirty = true;
  }

  private hover(sx: number, sy: number) {
    const now = performance.now();
    if (now - this.hoverAt < 120) return;
    this.hoverAt = now;
    const w = screenToWorld(this.view, sx, sy, this.wpt);
    const h = this.nav.core.roads.nearest(w.x, w.z, Math.max(8, 14 / this.view.scale));
    this.hoverName = h?.road.name ?? '';
  }

  // ------------------------------------------------------------------ the frame

  update(dt: number) {
    const g = this.game;
    if (this.disposed) return;
    const input = g.input;
    if (input.pressed('map') || (this.openFlag && input.pressed('pause'))) this.toggle();
    if (!this.openFlag) return;
    // the map closes itself when the player is down or arrested
    if (g.view.overlay) {
      this.close();
      return;
    }
    // held keys pan
    if (this.keys.size) {
      const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const sp = keyPanSpeed(fast) * dt;
      const dx = (this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('ArrowLeft') || this.keys.has('KeyA') ? 1 : 0);
      const dy = (this.keys.has('ArrowDown') || this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('ArrowUp') || this.keys.has('KeyW') ? 1 : 0);
      if (dx || dy) {
        // (dragging the map one way moves the world the other: a key that pans right shows what is to the right)
        panBy(this.view, -dx * sp, -dy * sp);
        this.dirty = true;
      }
      const zi = this.keys.has('KeyE') ? 1 : 0;
      const zo = this.keys.has('KeyQ') ? 1 : 0;
      if (zi !== zo) {
        zoomAbout(this.view, Math.exp((zi - zo) * 1.6 * dt), this.view.w / 2, this.view.h / 2);
        this.dirty = true;
      }
    }
    this.pollPad(dt);
    const now = performance.now();
    // tiles in view (about 4 times a second, or when the view moved far)
    if (this.dirty || now - this.lastRequest > 250) {
      const r = visibleRect(this.view, 100);
      const moved = Math.abs(r.minX - this.lastRect.minX) + Math.abs(r.minZ - this.lastRect.minZ) + Math.abs(r.maxX - this.lastRect.maxX);
      if (now - this.lastRequest > 250 || moved > 200) {
        this.lastRequest = now;
        this.lastRect = r;
        this.data.request(r, this.view.scale >= 0.1, now);
      }
    }
    // something moves (the player, the police, the pulsing pin) so the map is redrawn about 20 times a second at rest
    if (this.dirty || now - this.lastDraw > 50) {
      this.dirty = false;
      this.lastDraw = now;
      this.render(now);
    }
    this.updateDom(now);
  }

  private pollPad(dt: number) {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') pad = p;
    if (!pad) return;
    const pressed = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => {
      const now = pressed(i);
      const was = this.padPrev[i];
      this.padPrev[i] = now;
      return now && !was;
    };
    const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0;
    const ry = pad.axes[3] ?? 0;
    const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
    if (dead(lx) || dead(ly)) {
      this.cursorMode = true;
      panBy(this.view, -dead(lx) * 760 * dt, -dead(ly) * 760 * dt);
      this.dirty = true;
    }
    const z = (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0) - dead(ry);
    if (Math.abs(z) > 0.05) {
      zoomAbout(this.view, Math.exp(z * 1.6 * dt), this.view.w / 2, this.view.h / 2);
      this.dirty = true;
    }
    if (edge(0)) {
      this.cursorMode = true;
      this.toggleAtCursor();
    }
    if (edge(1)) this.close();
    if (edge(3)) this.centreOnPlayer();
    if (edge(2) && this.nav.core.waypoint) {
      this.nav.clearWaypoint();
      this.toast('Waypoint cleared');
    }
    // (View and Menu close it; D-pad down is the map action itself and is handled through Input)
    if (edge(8) || edge(9)) this.close();
  }

  // ------------------------------------------------------------------ drawing

  private render(now: number) {
    const ctx = this.ctx;
    const v = this.view;
    const dpr = this.dpr;
    const bv = this.bigView;
    bv.w = v.w;
    bv.h = v.h;
    bv.dpr = dpr;
    bv.scale = v.scale;
    bv.cx = v.cx;
    bv.cz = v.cz;
    const r = visibleRect(v);
    bv.minX = r.minX;
    bv.maxX = r.maxX;
    bv.minZ = r.minZ;
    bv.maxZ = r.maxZ;
    bv.time = now;

    bv.setScreen();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, v.w, v.h);
    const tiles = this.data.visible(visibleRect(v, 20), this.tmpTiles);

    // building footprints
    bv.setWorld();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (v.scale >= 0.1) {
      ctx.fillStyle = BUILDING;
      for (const t of tiles) {
        if (!t.buildings) continue;
        ctx.fill(t.buildings);
      }
    }
    // roads: every class's casing, then its fill, minor under major
    for (let rank = 0; rank <= 5; rank++) {
      if (v.scale < roadVisibleFrom(rank)) continue;
      for (const pass of [0, 1]) {
        for (const t of tiles) {
          for (const gr of t.groups) {
            if (gr.rank !== rank) continue;
            const style = rankStyle(rank);
            const w = Math.max(gr.width * (rank === 0 ? 0.8 : 1), style.minPx / v.scale);
            if (pass === 0) {
              ctx.strokeStyle = CASING;
              ctx.lineWidth = w + 2.6 / v.scale;
            } else {
              ctx.strokeStyle = style.color;
              ctx.lineWidth = w;
            }
            ctx.stroke(gr.path);
          }
        }
      }
    }
    // layers: the GPS route and the waypoint, rail lines and stations (anything registered on the layer hook)
    mapLayers(this.game).drawBigMap(bv);

    bv.setScreen();
    this.nOcc = 0;
    this.drawLabels(ctx, tiles);
    this.drawLandmarks(ctx);
    this.drawPeople(ctx, now);
    this.drawFurniture(ctx);
  }

  /** Street names along the roads, the avenues first; a label that would sit on another is left out. */
  private drawLabels(ctx: CanvasRenderingContext2D, tiles: MapTileGfx[]) {
    const v = this.view;
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    let drawn = 0;
    for (let rank = 5; rank >= 0 && drawn < MAX_LABELS; rank--) {
      if (v.scale < labelVisibleFrom(rank)) continue;
      for (const t of tiles) {
        for (const l of t.labels) {
          if (l.rank !== rank) continue;
          const p = worldToScreen(v, l.x, l.z, this.pt);
          if (p.x < -60 || p.y < -20 || p.x > v.w + 60 || p.y > v.h + 20) continue;
          const text = labelText(l.name);
          let tw = this.widthCache.get(text);
          if (tw === undefined) {
            tw = ctx.measureText(text).width;
            this.widthCache.set(text, tw);
          }
          // the road must be long enough on screen to carry its name
          if (l.length * v.scale < tw * 0.9) continue;
          if (!this.claim(p.x, p.y, tw + 8, 15, l.angle)) continue;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(l.angle);
          ctx.strokeStyle = LABEL_HALO;
          ctx.fillStyle = LABEL;
          ctx.strokeText(text, 0, 0);
          ctx.fillText(text, 0, 0);
          ctx.restore();
          if (++drawn >= MAX_LABELS) break;
        }
      }
    }
  }

  /** Reserves a (rotated) label box; false when it overlaps one already placed. */
  private claim(x: number, y: number, w: number, h: number, angle: number): boolean {
    const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const bw = w * c + h * s;
    const bh = w * s + h * c;
    const occ = this.occ;
    for (let i = 0; i < this.nOcc; i++) {
      const o = i * 4;
      if (Math.abs(x - occ[o]) < (bw + occ[o + 2]) / 2 && Math.abs(y - occ[o + 1]) < (bh + occ[o + 3]) / 2) return false;
    }
    if ((this.nOcc + 1) * 4 > occ.length) return true;
    const o = this.nOcc++ * 4;
    occ[o] = x;
    occ[o + 1] = y;
    occ[o + 2] = bw;
    occ[o + 3] = bh;
    return true;
  }

  private drawLandmarks(ctx: CanvasRenderingContext2D) {
    const v = this.view;
    ctx.font = '700 11.5px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    // heroes first so they win the label space
    for (const pass of [0, 1]) {
      for (const l of this.data.landmarks) {
        const hero = !!l.hero || l.kind === 'stadium' || l.kind === 'arena';
        if ((pass === 0) !== hero) continue;
        if (v.scale < (hero ? 0.09 : 0.32)) continue;
        const p = worldToScreen(v, l.x, l.z, this.pt);
        if (p.x < -80 || p.y < -20 || p.x > v.w + 80 || p.y > v.h + 20) continue;
        const r = hero ? 5.5 : 3.6;
        ctx.beginPath();
        if (hero) {
          ctx.moveTo(p.x, p.y - r * 1.3);
          ctx.lineTo(p.x + r, p.y);
          ctx.lineTo(p.x, p.y + r * 1.3);
          ctx.lineTo(p.x - r, p.y);
          ctx.closePath();
        } else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = hero ? GOLD : '#c7b27a';
        ctx.strokeStyle = 'rgba(10, 12, 15, 0.95)';
        ctx.lineWidth = 1.6;
        ctx.fill();
        ctx.stroke();
        const showName = hero ? v.scale >= 0.13 : v.scale >= 0.45;
        if (!showName) continue;
        const text = l.displayName;
        let tw = this.widthCache.get(`L${text}`);
        if (tw === undefined) {
          tw = ctx.measureText(text).width;
          this.widthCache.set(`L${text}`, tw);
        }
        if (!this.claim(p.x + r + 4 + tw / 2, p.y, tw + 8, 15, 0)) continue;
        ctx.lineWidth = 3;
        ctx.strokeStyle = LABEL_HALO;
        ctx.fillStyle = hero ? '#ffe09a' : '#d9cfae';
        ctx.strokeText(text, p.x + r + 4, p.y);
        ctx.fillText(text, p.x + r + 4, p.y);
      }
    }
  }

  /** The police and their search area, empty cars near the player, and the player's arrow. */
  private drawPeople(ctx: CanvasRenderingContext2D, now: number) {
    const g = this.game;
    const v = this.view;
    const gv = g.view;
    const st = gv.controlled;
    if (!st) return;
    const heatOn = gv.heat >= 1;
    const flash = flashPhase(now);
    if (heatOn && gv.searchR > 0 && (gv.heatPhase === HeatPhase.Lost || gv.heatPhase === HeatPhase.Reported)) {
      const c = worldToScreen(v, gv.searchX, gv.searchZ, this.pt);
      ctx.beginPath();
      ctx.arc(c.x, c.y, gv.searchR * v.scale, 0, Math.PI * 2);
      ctx.fillStyle = SEARCH_FILL;
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = SEARCH_LINE;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const e of gv.entities.values()) {
      if (e === st || e.id === gv.ped?.id) continue;
      const isPed = e.kind === EntityKind.Ped;
      const isCar = e.kind === EntityKind.Vehicle;
      if (!isPed && !isCar) continue;
      const police = isPed ? (e.flags & PedFlag.Police) !== 0 : (e.flags & VehicleFlag.Police) !== 0;
      if (police && !heatOn) continue;
      if (!police && (!isCar || (e.flags & VehicleFlag.Occupied) !== 0 || v.scale < 0.5)) continue;
      const p = worldToScreen(v, e.x, e.z, this.pt);
      if (p.x < -10 || p.y < -10 || p.x > v.w + 10 || p.y > v.h + 10) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, police ? (isPed ? 3.5 : 4.5) : 2.6, 0, Math.PI * 2);
      const lightbar = isPed || (e.flags & VehicleFlag.Lightbar) !== 0;
      ctx.fillStyle = police ? (lightbar && flash ? POLICE_RED : POLICE_BLUE) : EMPTY_CAR;
      ctx.fill();
    }
    // the player: a pulsing ring and an arrow that points where they face
    const p = worldToScreen(v, st.x, st.z, this.pt);
    const f = facingVector(yawOfQuat(st.q), this.fwd);
    const ang = Math.atan2(f[0], -f[1]);
    const pulse = (now % 1500) / 1500;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9 + pulse * 9, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.55 * (1 - pulse)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 4.5);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fillStyle = '#f4f4ef';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** The keyboard cursor, the north marker and the scale bar. */
  private drawFurniture(ctx: CanvasRenderingContext2D) {
    const v = this.view;
    if (this.cursorMode) {
      const cx = v.w / 2, cy = v.h / 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 14, cy);
      ctx.lineTo(cx - 5, cy);
      ctx.moveTo(cx + 5, cy);
      ctx.lineTo(cx + 14, cy);
      ctx.moveTo(cx, cy - 14);
      ctx.lineTo(cx, cy - 5);
      ctx.moveTo(cx, cy + 5);
      ctx.lineTo(cx, cy + 14);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // scale bar, bottom right above the panel
    const sb = scaleBar(v.scale);
    const x1 = v.w - 18, x0 = x1 - sb.px;
    const y = v.h - 74;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y - 4);
    ctx.lineTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.lineTo(x1, y - 4);
    ctx.stroke();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(formatScaleBar(sb.metres), x1, y - 6);
    ctx.textBaseline = 'middle';
    // north
    ctx.textAlign = 'center';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = '#ff6b5e';
    ctx.fillText('N', v.w - 24, 72);
  }

  // ------------------------------------------------------------------ the page around the canvas

  private toast(text: string, ms = 1800) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    this.toastUntil = performance.now() + ms;
  }

  private updateDom(now: number) {
    if (this.toastUntil && now > this.toastUntil) {
      this.toastEl.classList.remove('on');
      this.toastUntil = 0;
    }
    // where the pointer is, or where the player is
    const st = this.game.view.controlled;
    let where = this.hoverName;
    if (!where && st) where = this.nav.core.roads.nameAt(st.x, st.z, 30);
    if (where !== this.shownWhere) this.whereEl.textContent = this.shownWhere = where;
    const wp = this.nav.core.waypoint;
    if (!wp) {
      if (this.shownWp !== '') {
        this.shownWp = '';
        this.wpEl.hidden = true;
      }
    } else {
      const core = this.nav.core;
      const mode = core.route?.mode === 'walk' ? 'on foot' : 'by road';
      const status = core.status === 'searching' ? 'finding the route…' : core.status === 'noroute' ? 'no road route' : core.status === 'partial' ? `${this.nav.distanceText()} · to the edge of the map, then straight` : `${this.nav.distanceText()} ${mode}`;
      const name = wp.name || 'Waypoint';
      const key = `${name}|${status}`;
      if (key !== this.shownWp) {
        this.shownWp = key;
        this.wpEl.hidden = false;
        this.wpName.textContent = name;
        this.wpDist.textContent = status;
      }
    }
    this.renderHint();
  }

  private renderHint() {
    const dev = this.game.input.device;
    const text =
      dev === 'touch'
        ? '<b>Tap</b> the map to set a waypoint, tap it again to clear · <b>Drag</b> to pan · <b>Pinch</b> to zoom'
        : dev === 'gamepad'
          ? '<b>A</b> set or clear at the cross · <b>Left stick</b> pan · <b>Right stick</b> or <b>triggers</b> zoom · <b>Y</b> centre · <b>B</b> close'
          : '<b>Click</b> to set a waypoint, click it again to clear · <b>Drag</b> pan · <b>Wheel</b> or <b>pinch</b> zoom · <b>Arrows</b> or <b>WASD</b> pan · <b>Q E</b> or <b>+ −</b> zoom · <b>Enter</b> sets at the cross · <b>C</b> centre · <b>Tab</b> close';
    if (text !== this.shownHint) {
      this.shownHint = text;
      this.hintEl.innerHTML = text;
    }
  }

  dispose() {
    this.disposed = true;
    this.close();
    for (const f of this.off) f();
    this.off.length = 0;
    this.data.dispose();
    this.root.remove();
  }
}

function rankStyle(rank: number) {
  switch (rank) {
    case 5:
      return mapRoadStyle('motorway');
    case 4:
      return mapRoadStyle('trunk');
    case 3:
      return mapRoadStyle('primary');
    case 2:
      return mapRoadStyle('secondary');
    case 1:
      return mapRoadStyle('tertiary');
    default:
      return mapRoadStyle('service');
  }
}
