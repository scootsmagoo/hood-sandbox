/**
 * The gun's heads-up display: the crosshair (its gap is the bullet spread, so it blooms as you
 * fire), the lock-on marker on a threat, the hit marker, the ammo count with a reload bar, and the
 * weapon strip. All plain DOM, created once; nothing here is made or removed while playing.
 */
import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER } from '../../shared/weapons';
import type { Game, System } from '../Game';
import { codeLabel } from '../input/bindings';

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

declare module '../Game' {
  interface Game {
    gunHud: GunHud;
  }
}

export class GunHud implements System {
  readonly name = 'gunHud';
  readonly priority = 210;
  private readonly root: HTMLElement;
  private readonly cross: HTMLElement;
  private readonly ticks: HTMLElement[] = [];
  private readonly lock: HTMLElement;
  private readonly hitmark: HTMLElement;
  private readonly ammo: HTMLElement;
  private readonly wname: HTMLElement;
  private readonly mag: HTMLElement;
  private readonly reserve: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly reloadFill: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly cover: HTMLElement;
  private readonly hurt: HTMLElement;
  private hurtT = 0;
  private readonly v = new THREE.Vector3();
  private wasActive = false;
  private cache = { mag: -1, reserve: -2, weapon: '', gap: -1, owned: -1, cur: '', reload: -1, flags: '' };

  constructor(private readonly game: Game) {
    game.gunHud = this;
    const host = document.getElementById('hud') ?? document.body;
    this.root = el('div', 'gun-hud', host);
    this.cross = el('div', 'xhair', this.root);
    for (const d of ['t', 'b', 'l', 'r']) this.ticks.push(el('i', `tick ${d}`, this.cross));
    el('b', 'dot', this.cross);
    this.lock = el('div', 'gun-lock', this.root);
    this.hitmark = el('div', 'gun-hit', this.root);
    for (const d of ['a', 'b', 'c', 'd']) el('i', d, this.hitmark);
    this.ammo = el('div', 'gun-ammo', this.root);
    this.wname = el('div', 'wname', this.ammo);
    const rounds = el('div', 'rounds', this.ammo);
    this.mag = el('span', 'mag', rounds);
    this.reserve = el('span', 'res', rounds);
    this.reloadBar = el('div', 'reload', this.ammo);
    this.reloadFill = el('i', '', this.reloadBar);
    this.strip = el('div', 'gun-strip', this.root);
    WEAPON_ORDER.forEach((id, i) => {
      const s = el('div', 'slot', this.strip);
      el('b', '', s, String(i + 1));
      el('span', '', s, WEAPONS[id].name);
      this.slots.push(s);
    });
    this.cover = el('div', 'gun-cover', this.root);
    // A bullet hits the player: the edges of the screen flash red.
    this.hurt = el('div', 'gun-hurt', this.root);
    game.onSimEvent((e) => {
      if (e.type === 'damage' && e.kind === 'bullet' && e.targetId === game.view.ped?.id) this.hurtT = 0.45;
    });
    this.root.hidden = true;
  }

  update(dt: number) {
    const g = this.game;
    const a = g.aim;
    const v = g.view;
    const ped = v.ped;
    const armed = !!a.weapon && !!ped;
    // Shot at while unarmed still flashes.
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.root.hidden = !armed && !a.inCover && !a.crouched && this.hurtT <= 0;
    if (this.root.hidden) return;
    this.hurt.style.opacity = this.hurtT > 0 ? String(Math.min(1, this.hurtT * 2.2)) : '0';
    if (!armed && !a.inCover && !a.crouched) return;
    const w = a.weapon;

    // Crosshair: only while the gun is up. Its gap is the spread in pixels.
    this.cross.classList.toggle('on', a.active);
    if (a.active) {
      const h = g.canvas.clientHeight || window.innerHeight;
      const gap = Math.max(5, Math.round((Math.tan((a.spreadDeg * Math.PI) / 180) * h * 0.5) / Math.tan((g.camera.fov * Math.PI) / 360)));
      if (gap !== this.cache.gap) {
        this.cache.gap = gap;
        this.cross.style.setProperty('--gap', `${gap}px`);
      }
      this.cross.classList.toggle('locked', a.lock !== 0);
    }

    // The lock-on marker rides the target, for a pad or a finger (a mouse gets only the magnetism).
    const target = a.active && a.lock && g.input.device !== 'keyboard' ? v.entities.get(a.lock) : undefined;
    if (target) {
      this.v.set(target.x, target.y + 1.2, target.z).project(g.camera);
      const cw = g.canvas.clientWidth || window.innerWidth;
      const ch = g.canvas.clientHeight || window.innerHeight;
      if (this.v.z < 1) {
        this.lock.style.transform = `translate(${((this.v.x * 0.5 + 0.5) * cw).toFixed(1)}px, ${((-this.v.y * 0.5 + 0.5) * ch).toFixed(1)}px) rotate(45deg)`;
        this.lock.classList.add('on');
      } else this.lock.classList.remove('on');
    } else this.lock.classList.remove('on');

    this.hitmark.classList.toggle('on', a.hit > 0 || a.kill > 0);
    this.hitmark.classList.toggle('kill', a.kill > 0);

    // Ammo.
    if (w) {
      if (w.name !== this.cache.weapon) {
        this.cache.weapon = w.name;
        this.wname.textContent = w.name;
      }
      if (a.mag !== this.cache.mag) {
        this.cache.mag = a.mag;
        this.mag.textContent = String(a.mag);
        this.mag.classList.toggle('low', a.mag <= Math.ceil(w.magazine * 0.25));
      }
      // 255 spare rounds stands for "never runs out" (police); the player's are finite.
      if (a.reserve !== this.cache.reserve) {
        this.cache.reserve = a.reserve;
        // 255 is the snapshot's mark for spare rounds that never run out.
        this.reserve.textContent = a.reserve >= 255 ? '/ ∞' : `/ ${a.reserve}`;
      }
      this.ammo.classList.toggle('empty', a.empty > 0 || (a.mag === 0 && a.reload === 0));
      const rl = Math.round(a.reload * 100);
      if (rl !== this.cache.reload) {
        this.cache.reload = rl;
        this.reloadBar.classList.toggle('on', rl > 0);
        this.reloadFill.style.width = `${rl}%`;
      }
    }

    // The weapon strip: shown for a moment after a switch, and as the gun comes up.
    if (a.active && !this.wasActive) a.strip = Math.max(a.strip, 1.6);
    this.wasActive = a.active;
    this.strip.classList.toggle('on', a.strip > 0);
    if (a.strip > 0) {
      const cur = w ? w.id : '';
      if (a.owned !== this.cache.owned || cur !== this.cache.cur) {
        this.cache.owned = a.owned;
        this.cache.cur = cur;
        WEAPON_ORDER.forEach((id, i) => {
          this.slots[i].classList.toggle('have', (a.owned & (1 << i)) !== 0);
          this.slots[i].classList.toggle('cur', id === cur);
        });
      }
    }

    const flags = a.inCover ? 'high' : a.crouched ? 'low' : '';
    if (flags !== this.cache.flags) {
      this.cache.flags = flags;
      this.cover.textContent = flags ? `In cover  [${codeLabel(g.input.bindings.cover[0] ?? 'X')}] leave` : '';
      this.cover.classList.toggle('on', !!flags);
    }
  }

  dispose() {
    this.root.remove();
  }
}
