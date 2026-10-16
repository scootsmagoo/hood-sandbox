/**
 * The transit HUD: on a platform, when the next trains are due (the snapshot's ETAs for the platform the player is at); at an
 * open door, the prompt to get on; on a train, the line and where it goes, the next station, the prompts to get off (when the
 * doors are open) and to skip to the next station; the fade of a skip; the fare gates' notes ("Fare paid", "Fare evasion").
 */
import { H, SnapFlag, TR, TrainFlag, TransitInfo } from '../../shared/snapshot';
import type { SimEvent } from '../../shared/protocol';
import { EntityKind } from '../../shared/entities';
import type { Game, System } from '../Game';
import { codeLabel } from '../input/bindings';
import { padButtonFor, padButtonLabel } from '../input/gamepad';
import { etaText } from '../render/transit/TransitView';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

export class TransitHud implements System {
  readonly name = 'transitHud';
  readonly priority = 205;
  private readonly root: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly ride: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly fade: HTMLDivElement;
  private readonly note: HTMLDivElement;
  private readonly skipBtn: HTMLButtonElement;
  private noteUntil = 0;
  private fadeTarget = 0;
  private fadeOp = 0;
  private cache = { board: '', ride: '', prompt: '' };

  constructor(private readonly game: Game) {
    const hud = document.getElementById('hud') ?? document.body;
    this.root = el('div', 'transit-hud', hud);
    this.board = el('div', 'transit-board', this.root);
    this.ride = el('div', 'transit-ride', this.root);
    this.prompt = el('div', 'transit-prompt', this.root);
    this.note = el('div', 'transit-note', this.root);
    this.fade = el('div', 'transit-fade', document.body);
    this.skipBtn = el('button', 'transit-skip', this.root);
    this.skipBtn.textContent = 'Next station';
    // a finger's skip: the button holds the action for a moment
    this.skipBtn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      game.input.holdAction('skip', true);
      setTimeout(() => game.input.holdAction('skip', false), 120);
    });
    game.onSimEvent((e) => this.onEvent(e));
  }

  private key(action: Parameters<Game['input']['down']>[0]): string {
    const { input } = this.game;
    if (input.device === 'gamepad') {
      const b = padButtonFor(action);
      if (b !== undefined) return padButtonLabel(b, this.game.gamepad?.family ?? 'generic');
    }
    if (input.device === 'touch') return '';
    const codes = input.bindings[action] ?? [];
    const c = codes.find((x) => x.startsWith('Key')) ?? codes[0];
    return c ? codeLabel(c) : '?';
  }

  private onEvent(e: SimEvent) {
    const g = this.game;
    const v = g.view;
    const now = performance.now();
    switch (e.type) {
      case 'transit:skip':
        this.fadeTarget = e.phase === 'out' ? 1 : 0;
        break;
      case 'transit:fare':
        if (e.pedId === v.ped?.id) this.toast('Fare paid', now);
        break;
      case 'transit:evade':
        if (e.pedId === v.ped?.id) this.toast('Fare evasion', now);
        break;
      case 'transit:board':
        if (e.pedId === v.ped?.id) this.toast('Doors closing soon: take a seat', now, 1600);
        break;
    }
  }

  private toast(text: string, now: number, ms = 1800) {
    this.note.textContent = text;
    this.note.classList.add('on');
    this.noteUntil = now + ms;
  }

  private failed = false;

  update(dt: number) {
    if (this.failed) return;
    try {
      this.frame(dt);
    } catch (e) {
      console.warn('transit HUD failed; hidden', e);
      this.failed = true;
      this.root.style.display = 'none';
      this.fade.style.opacity = '0';
    }
  }

  private frame(dt: number) {
    const g = this.game;
    const tv = g.transit?.broken ? undefined : g.transit;
    const s = g.view.sample?.b;
    const now = performance.now();
    this.fadeOp += (this.fadeTarget - this.fadeOp) * Math.min(1, dt * (this.fadeTarget > this.fadeOp ? 3.2 : 1.8));
    this.fade.style.opacity = this.fadeOp < 0.01 ? '0' : this.fadeOp.toFixed(3);
    if (this.noteUntil && now > this.noteUntil) {
      this.note.classList.remove('on');
      this.noteUntil = 0;
    }
    if (!tv || !s) return;
    const d = tv.data;
    const info = s.u32[H.TransitInfo];
    const station = TransitInfo.station(info);
    const riding = (s.u32[H.Flags] & SnapFlag.OnTrain) !== 0;
    const door = TransitInfo.door(info);
    const use = this.key('interact');
    const skipKey = this.key('skip');

    // the departures board of the platform the player is at
    let board = '';
    if (!riding && station >= 0) {
      const st = d.stations[station];
      const routes = s.u32[H.EtaRoutes];
      const rows: string[] = [];
      for (let k = 0; k < 2; k++) {
        const r = ((routes >>> (k * 8)) & 0xff) - 1;
        const eta = s.f32[k === 0 ? H.Eta0 : H.Eta1];
        if (r < 0 || eta < 0) continue;
        const route = d.routes[r];
        const line = d.lines[route.line];
        rows.push(`<div class="row"><i style="background:${line.colour}"></i><b>${line.name}</b><span>to ${route.towards}</span><em>${etaText(eta)}</em></div>`);
      }
      board = `<div class="title">${st.displayName}</div>${rows.join('') || '<div class="row"><span>No trains due</span></div>'}`;
    }
    if (board !== this.cache.board) {
      this.board.innerHTML = this.cache.board = board;
      this.board.classList.toggle('on', board !== '');
    }

    // on a train: the line, the next stop
    let ride = '';
    if (riding) {
      const id = s.u32[H.Train];
      const i = s.indexOf(id);
      if (i >= 0) {
        const o = s.at(i);
        const route = d.routes[Math.round(s.f32[o + 34])];
        if (route) {
          const line = d.lines[route.line];
          const next = route.stops[s.u32[o + TR.NextStop]];
          const nextName = next ? d.stations[next.station].displayName : 'End of the line';
          // standing at a stop, the stop's index is still the station it stands at
          const dwelling = (s.u32[o + 12] & TrainFlag.Dwelling) !== 0;
          ride = `<div class="line"><i style="background:${line.colour}"></i>${line.name} to ${route.towards}</div>` + (dwelling ? `<div class="here">${nextName}</div>` : `<div class="next">Next: ${nextName}</div>`);
        }
      }
    }
    if (ride !== this.cache.ride) {
      this.ride.innerHTML = this.cache.ride = ride;
      this.ride.classList.toggle('on', ride !== '');
    }

    let prompt = '';
    if (riding) prompt = door === 2 ? `[${use}] Get off   [${skipKey}] Next station   [V] View` : `[${skipKey}] Next station   [V] View`;
    else if (door === 1) prompt = `[${use}] Board`;
    if (prompt !== this.cache.prompt) {
      this.prompt.textContent = this.cache.prompt = prompt;
      this.prompt.classList.toggle('on', prompt !== '');
    }
    this.skipBtn.classList.toggle('on', riding && g.input.device === 'touch');
    if (riding || door === 1) g.touch?.setUseLabel(riding ? 'Get off' : 'Board');
    void EntityKind;
  }
}
