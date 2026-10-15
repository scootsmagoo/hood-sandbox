/**
 * The law's heads-up cues, kept apart from the main HUD:
 *
 * - **The 911 cue.** When a witness's call goes through (`crime:reported`, not a duplicate and not an officer
 *   seeing it) the hollow stars pulse and a small "phone, 911, police notified" tag shows under them for about
 *   two seconds. It replaces the old "Someone called it in" toast: it sits where the player looks for the heat,
 *   and says the police are now coming.
 * - **The dialling marker.** A witness who is calling has a small phone over their head with a ring that fills as
 *   the call nears (the snapshot's `PedFlag.Dialling`, progress in `aux2`). It is the player's chance to stop it
 *   (knock the caller down; `witness:silenced` flashes the marker red as it goes). A pool of DOM elements,
 *   projected to the screen each frame: nothing is made or removed while playing.
 */
import * as THREE from 'three';
import { EntityKind } from '../../shared/entities';
import type { SimEvent } from '../../shared/protocol';
import { PedFlag } from '../../shared/snapshot';
import type { Game, System } from '../Game';

const CUE_S = 2.2;
const MAX_DIALS = 8;
/** Callers farther than this from the player get no marker, m. */
const DIAL_RANGE = 60;
/** A phone handset in a 24 x 24 box. */
const PHONE_PATH = 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function phone(parent: HTMLElement): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PHONE_PATH);
  svg.appendChild(path);
  parent.appendChild(svg);
  return svg;
}

interface Dial {
  el: HTMLElement;
  /** The ped this marker is on, or 0. */
  id: number;
  /** Seconds left of the red "call stopped" flash; the marker stays put while it runs. */
  cutT: number;
  x: number;
  y: number;
}

export class LawHud implements System {
  readonly name = 'lawHud';
  readonly priority = 205;
  private readonly layer: HTMLElement;
  private readonly cue: HTMLElement;
  private readonly stars: HTMLElement | null;
  private readonly dials: Dial[] = [];
  private readonly v = new THREE.Vector3();
  private cueT = 0;

  constructor(private readonly game: Game) {
    const host = document.getElementById('hud') ?? document.body;
    this.stars = host.querySelector<HTMLElement>('.hud-stars');
    this.cue = el('div', 'law-call', this.stars ?? host);
    phone(this.cue);
    el('b', '', this.cue, '911');
    el('span', '', this.cue, 'Police notified');
    this.layer = el('div', 'law-dials', host);
    for (let i = 0; i < MAX_DIALS; i++) {
      const d = el('div', 'law-dial off', this.layer);
      phone(d);
      this.dials.push({ el: d, id: 0, cutT: 0, x: 0, y: 0 });
    }
    game.onSimEvent((e) => this.onEvent(e));
  }

  private onEvent(e: SimEvent) {
    if (e.type === 'crime:reported') {
      // A witness got through. (An officer seeing it turns the stars solid by itself; a second caller about the same crime changes nothing.)
      if (e.police || e.duplicate) return;
      this.cueT = CUE_S;
      for (const t of [this.cue, this.stars]) {
        if (!t) continue;
        // Restart the animation if a second, different crime's call lands inside the first one's two seconds.
        t.removeAttribute('data-call');
        void t.offsetWidth;
        t.setAttribute('data-call', '1');
      }
    } else if (e.type === 'witness:silenced') {
      const d = this.dials.find((x) => x.id === e.pedId);
      if (d) d.cutT = 0.7;
    }
  }

  private readonly near: { id: number; x: number; y: number; z: number; p: number; d: number }[] = [];

  update(dt: number) {
    const g = this.game;
    if (this.cueT > 0) {
      this.cueT -= dt;
      if (this.cueT <= 0) {
        this.cue.removeAttribute('data-call');
        this.stars?.removeAttribute('data-call');
      }
    }

    const me = g.view.controlled;
    const cw = g.viewW;
    const ch = g.viewH;
    // Who is calling and near enough to matter, nearest first (at most as many as there are markers). The list is reused.
    const near = this.near;
    near.length = 0;
    if (me) {
      for (const e of g.view.entities.values()) {
        if (e.kind !== EntityKind.Ped || (e.flags & PedFlag.Dialling) === 0) continue;
        const d = Math.hypot(e.x - me.x, e.z - me.z);
        if (d <= DIAL_RANGE) near.push({ id: e.id, x: e.x, y: e.y, z: e.z, p: e.aux2, d });
      }
      if (near.length > 1) near.sort((a, b) => a.d - b.d);
    }
    // Nobody dialling and no marker up: nothing to touch this frame.
    if (!near.length && this.dials.every((d) => d.id === 0)) return;
    // Keep a marker on the same person from frame to frame; free the ones whose call is over (after a red flash if it was stopped).
    for (const d of this.dials) {
      if (d.id === 0) continue;
      if (d.cutT > 0) {
        d.cutT -= dt;
        d.el.classList.add('cut');
        // The red marker stays on the person while it flashes (they are on the ground now).
        const e = g.view.entities.get(d.id);
        if (e) this.place(d, e.x, e.y, e.z, cw, ch);
        if (d.cutT <= 0) this.release(d);
        continue;
      }
      const i = near.findIndex((n) => n.id === d.id);
      if (i < 0) this.release(d);
    }
    for (const n of near) {
      let d = this.dials.find((x) => x.id === n.id);
      if (!d) {
        d = this.dials.find((x) => x.id === 0);
        if (!d) break;
        d.id = n.id;
        d.cutT = 0;
        d.el.classList.remove('cut');
      }
      if (d.cutT > 0) continue;
      this.place(d, n.x, n.y, n.z, cw, ch);
      d.el.style.setProperty('--p', n.p.toFixed(3));
    }
  }

  /** Puts a marker over a person at (x, y, z), or hides it when that point is behind the camera or off screen. */
  private place(d: Dial, x: number, y: number, z: number, cw: number, ch: number) {
    this.v.set(x, y + 2.15, z).project(this.game.camera);
    if (this.v.z >= 1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) {
      d.el.classList.add('off');
      return;
    }
    d.x = (this.v.x * 0.5 + 0.5) * cw;
    d.y = (-this.v.y * 0.5 + 0.5) * ch;
    d.el.classList.remove('off');
    d.el.style.transform = `translate(${d.x.toFixed(1)}px, ${d.y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  private release(d: Dial) {
    d.id = 0;
    d.cutT = 0;
    d.el.classList.remove('cut');
    d.el.classList.add('off');
  }
}
