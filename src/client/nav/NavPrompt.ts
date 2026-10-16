/**
 * The turn prompt beside the radar: an arrow, the next manoeuvre ("Turn left onto Peachtree St NE"), how far to it and how far is
 * left in all. Shown only while there is a waypoint. The DOM is written only when the text changes.
 */
import type { NavCore } from './core';
import { abbreviateStreet } from '../ui/streetNameMath';
import { describeStep, formatDistance, type TurnKind } from './route';

const ARROW: Record<TurnKind, { rot: number; path: string }> = {
  left: { rot: -90, path: 'M12 20V8M12 8L6 14M12 8l6 6' },
  right: { rot: 90, path: 'M12 20V8M12 8L6 14M12 8l6 6' },
  straight: { rot: 0, path: 'M12 20V6M12 6L6 12M12 6l6 6' },
  ramp: { rot: 20, path: 'M12 20V6M12 6L6 12M12 6l6 6' },
  uturn: { rot: 180, path: 'M12 20V6M12 6L6 12M12 6l6 6' },
  turnaround: { rot: 180, path: 'M12 20V6M12 6L6 12M12 6l6 6' },
  arrive: { rot: 0, path: 'M12 3l6 9-6 9-6-9z' },
};

export class NavPrompt {
  readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly arrowPath: SVGPathElement;
  private readonly mainEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private shown = false;
  private last = { main: '', sub: '', kind: '' };
  private acc = 0;

  constructor(
    private readonly core: NavCore,
    parent: HTMLElement,
    leftPx: number,
    bottomPx: number,
  ) {
    const root = (this.root = document.createElement('div'));
    root.className = 'hud-nav';
    root.setAttribute('aria-live', 'polite');
    Object.assign(root.style, { position: 'absolute', left: `${leftPx}px`, bottom: `${bottomPx}px`, display: 'none' });
    const ns = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(ns, 'svg');
    this.svg.setAttribute('viewBox', '0 0 24 24');
    this.svg.setAttribute('class', 'nav-arrow');
    this.arrowPath = document.createElementNS(ns, 'path');
    this.svg.appendChild(this.arrowPath);
    const text = document.createElement('div');
    text.className = 'nav-text';
    this.mainEl = document.createElement('div');
    this.mainEl.className = 'nav-main';
    this.subEl = document.createElement('div');
    this.subEl.className = 'nav-sub';
    text.append(this.mainEl, this.subEl);
    root.append(this.svg, text);
    parent.appendChild(root);
  }

  update(dt: number) {
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    const core = this.core;
    const wp = core.waypoint;
    if (!wp) {
      if (this.shown) this.setShown(false);
      return;
    }
    let main = '';
    let sub = '';
    let kind: TurnKind = 'straight';
    const route = core.route;
    const status = core.status;
    if (!route || status === 'searching') {
      main = 'Finding the route…';
      kind = 'straight';
    } else {
      const t = core.track;
      const s = t?.s ?? 0;
      const remaining = t?.remaining ?? route.remaining(0);
      const step = route.nextStep(s);
      const off = (t?.off ?? 0) > 25;
      if (off) {
        main = 'Off route. Finding a new one…';
      } else if (status === 'noroute') {
        main = wp.name ? `No road route. Head straight for ${abbreviateStreet(wp.name)}` : 'No road route. Head straight on';
      } else if (step && step.kind !== 'arrive') {
        main = describeStep(step);
        kind = step.kind;
        sub = `in ${formatDistance(Math.max(0, step.s - s))} · ${formatDistance(remaining)} to go`;
      } else if (route.partial) {
        main = 'Follow the road, then straight on';
        sub = `${formatDistance(remaining)} to go`;
      } else {
        main = remaining < 90 ? 'Your destination is ahead' : wp.name ? `Continue to ${abbreviateStreet(wp.name)}` : 'Continue straight';
        kind = remaining < 90 ? 'arrive' : 'straight';
        sub = `${formatDistance(remaining)} to go`;
      }
    }
    if (!this.shown) this.setShown(true);
    if (main !== this.last.main) this.mainEl.textContent = this.last.main = main;
    if (sub !== this.last.sub) {
      this.subEl.textContent = this.last.sub = sub;
      this.subEl.hidden = sub === '';
    }
    if (kind !== this.last.kind) {
      this.last.kind = kind;
      const a = ARROW[kind];
      this.arrowPath.setAttribute('d', a.path);
      this.svg.style.transform = `rotate(${a.rot}deg)`;
      this.svg.classList.toggle('pin', kind === 'arrive');
    }
  }

  private setShown(on: boolean) {
    this.shown = on;
    this.root.style.display = on ? 'flex' : 'none';
    if (!on) this.last = { main: '', sub: '', kind: '' };
  }

  dispose() {
    this.root.remove();
  }
}
