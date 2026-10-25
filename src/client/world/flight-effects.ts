import type { RoundView } from '../../shared/types.js';
import { MAX_PUMPS } from '../../shared/settings.js';
import {
  FLIGHT_ZONES,
  getFlightEnding,
  type FlightZone,
} from '../flight-model.js';
import { multiplier } from '../format.js';
import { element } from '../dom.js';
import type { GameAudio } from '../audio.js';
import { FLIGHT_TIMING } from '../flight-timing.js';
import { find } from './dom.js';
import { MotionGroup } from './motion.js';

const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const SPRING = 'cubic-bezier(.2,.8,.2,1)';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Short, interruptible sequences. Ambient creatures and camera movement live elsewhere.
export class FlightEffects {
  private readonly pumpMotion = new MotionGroup();
  private readonly biomeMotion = new MotionGroup();
  private readonly endingMotion = new MotionGroup();
  private readonly balloon: HTMLElement;
  private readonly flight: HTMLElement;
  private readonly particles: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly wash: HTMLElement;
  private readonly biome: HTMLElement;
  private settling = false;
  private generation = 0;
  private pumpId = 0;
  private biomeId = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly audio: GameAudio,
    private readonly onSettlementChange: () => void,
    private readonly reducedMotion: MediaQueryList,
  ) {
    root.style.setProperty('--pump-duration', `${FLIGHT_TIMING.pumpMs}ms`);
    this.balloon = find(root, '#balloon');
    this.flight = find(root, '#balloon-flight');
    this.particles = find(root, '#scene-particles');
    this.banner = find(root, '#result-banner');
    this.ring = find(root, '#ending-ring');
    this.wash = find(root, '#scene-wash');
    this.biome = find(root, '#biome-reveal');
  }

  get isSettling(): boolean {
    return this.settling;
  }

  private setSettling(value: boolean): void {
    if (value === this.settling) return;
    this.settling = value;
    this.root.toggleAttribute('data-settling', value);
    this.onSettlementChange();
  }

  pause(hidden: boolean): void {
    for (const group of [this.pumpMotion, this.biomeMotion, this.endingMotion])
      group.pause(hidden);
  }

  reset(): void {
    this.audio.stopEffects();
    this.generation++;
    this.pumpId++;
    this.biomeId++;
    this.pumpMotion.clear();
    this.biomeMotion.clear();
    this.endingMotion.clear();
    this.biome.hidden = true;
    delete this.root.dataset.moving;
    delete this.root.dataset.biomeReveal;
    delete this.root.dataset.endingEffect;
    this.setSettling(false);
  }

  pump(round: RoundView): void {
    this.pumpMotion.clear();
    const id = ++this.pumpId;
    this.audio.play('inflate');
    if (this.reducedMotion.matches) return;
    const motion = this.pumpMotion;
    this.root.dataset.moving = 'true';
    motion.play(
      this.balloon,
      [
        { scale: '1 1', rotate: '0deg' },
        { scale: '1.025 .99', rotate: '-.4deg', offset: 0.25 },
        { scale: '1.09 .95', rotate: '-2deg', offset: 0.7 },
        { scale: '1.13 .93', rotate: '-2deg', offset: 0.85 },
        { scale: '.98 1.035', rotate: '1.5deg', offset: 0.95 },
        { scale: '1 1', rotate: '0deg' },
      ],
      { duration: FLIGHT_TIMING.pumpMs, easing: 'linear' },
    );
    motion.play(
      find(this.root, '#pump-ripple'),
      [
        { opacity: 0, transform: 'translate(-50%, -50%) scale(.6)' },
        {
          opacity: 0.75,
          transform: 'translate(-50%, -50%) scale(.85)',
          offset: 0.18,
        },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(1.65)' },
      ],
      { duration: FLIGHT_TIMING.pumpMs, easing: EASE_OUT },
    );
    motion.play(
      find(this.root, '#pump-air'),
      [
        { opacity: 0, transform: 'translate(-50%, 18px) scaleY(.4)' },
        {
          opacity: 0.8,
          transform: 'translate(-50%, -6px) scaleY(1)',
          offset: 0.35,
        },
        { opacity: 0, transform: 'translate(-50%, -38px) scaleY(.65)' },
      ],
      { duration: FLIGHT_TIMING.pumpMs, easing: 'ease-in-out' },
    );
    for (const target of [
      find(this.root, '#multiplier'),
      find(this.root, '#pump-count'),
      element('#payout'),
    ]) {
      motion.play(
        target,
        [
          { opacity: 0.6, translate: '0 7px', scale: '.94' },
          { opacity: 1, translate: '0 -2px', scale: '1.025', offset: 0.6 },
          { opacity: 1, translate: '0 0', scale: '1' },
        ],
        { duration: 430, easing: SPRING },
      );
    }
    this.burst(
      motion,
      6,
      'pump-spark',
      80 + (round.pumps / MAX_PUMPS) * 24,
      FLIGHT_TIMING.pumpMs,
    );
    const gain = document.createElement('span');
    gain.className = 'pump-gain';
    gain.textContent = `${multiplier(round.multiplierMicros)}×`;
    this.particles.append(gain);
    motion.particle(
      gain,
      [
        { opacity: 0, transform: 'translate(66px, -12px) scale(.8)' },
        {
          opacity: 1,
          transform: 'translate(86px, -30px) scale(1)',
          offset: 0.3,
        },
        { opacity: 0, transform: 'translate(96px, -64px) scale(.95)' },
      ],
      { duration: 800, easing: EASE_OUT },
    );
    void motion.finished().then(() => {
      if (id === this.pumpId) delete this.root.dataset.moving;
    });
  }

  enterBiome(zone: FlightZone): void {
    this.biomeMotion.clear();
    const id = ++this.biomeId;
    this.biome.hidden = true;
    if (this.reducedMotion.matches) return;
    find(this.biome, '#biome-title').textContent = zone.name;
    find(this.biome, '#biome-caption').textContent = zone.caption;
    find(this.biome, '#biome-label').textContent =
      `NEW HORIZON · ${String(FLIGHT_ZONES.findIndex((entry) => entry.id === zone.id) + 1).padStart(2, '0')} / ${String(FLIGHT_ZONES.length).padStart(2, '0')}`;
    find<SVGUseElement>(this.biome, 'use').setAttribute(
      'href',
      `#icon-${zone.icon}`,
    );
    this.biome.hidden = false;
    this.root.dataset.biomeReveal = zone.id;
    const motion = this.biomeMotion;
    motion.play(
      this.biome,
      [
        { opacity: 0, transform: 'translateX(-24px) scale(.96)' },
        { opacity: 1, transform: 'translateX(0) scale(1)', offset: 0.22 },
        { opacity: 1, transform: 'translateX(0) scale(1)', offset: 0.78 },
        { opacity: 0, transform: 'translateX(12px) scale(.99)' },
      ],
      { duration: 2400, delay: 220, easing: 'ease-in-out', fill: 'backwards' },
    );
    motion.play(
      find(this.root, '#biome-wash'),
      [
        { opacity: 0, transform: 'translateY(70%)' },
        { opacity: 0.28, transform: 'translateY(0)', offset: 0.4 },
        { opacity: 0, transform: 'translateY(-65%)' },
      ],
      { duration: 1500, easing: EASE_OUT },
    );
    this.burst(motion, 8, 'biome-spark', 180, 1400, 100);
    void motion.finished().then(() => {
      if (id !== this.biomeId) return;
      this.biome.hidden = true;
      delete this.root.dataset.biomeReveal;
    });
  }

  settle(round: RoundView): void {
    this.reset();
    const ending = getFlightEnding(round);
    if (!ending) return;
    this.audio.play(ending);
    if (this.reducedMotion.matches) return;
    const generation = this.generation;
    const motion = this.endingMotion;
    this.root.dataset.endingEffect = ending;
    this.setSettling(true);

    if (ending === 'pop') this.pop();
    else if (ending === 'summit') this.summit();
    else this.cashout();

    const delay =
      ending === 'pop'
        ? 220
        : ending === 'summit'
          ? FLIGHT_TIMING.summitResultMs
          : FLIGHT_TIMING.cashoutResultMs;
    motion.play(
      this.banner,
      [
        { opacity: 0, transform: 'translate(-50%, -40%) scale(.88)' },
        {
          opacity: 1,
          transform: 'translate(-50%, -52%) scale(1.025)',
          offset: 0.72,
        },
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
      ],
      { duration: 680, delay, easing: SPRING, fill: 'backwards' },
    );
    motion.play(
      find(this.root, '#result-icon'),
      [
        { opacity: 0, scale: '.4', rotate: '-18deg' },
        { opacity: 1, scale: '1.15', rotate: '5deg', offset: 0.65 },
        { opacity: 1, scale: '1', rotate: '0deg' },
      ],
      { duration: 650, delay: delay + 100, easing: SPRING, fill: 'backwards' },
    );
    motion.play(
      find(this.root, '#result-value'),
      [
        { opacity: 0, translate: '0 12px', scale: '.9' },
        { opacity: 1, translate: '0 0', scale: '1' },
      ],
      {
        duration: 650,
        delay: delay + 220,
        easing: EASE_OUT,
        fill: 'backwards',
      },
    );
    void motion.finished().then(() => {
      if (generation !== this.generation) return;
      delete this.root.dataset.endingEffect;
      this.setSettling(false);
    });
  }

  private pop(): void {
    const motion = this.endingMotion;
    const bounds = this.balloon.getBoundingClientRect();
    const scene = this.root.getBoundingClientRect();
    motion.play(
      this.flight,
      [
        { opacity: 1, scale: '1' },
        { opacity: 1, scale: '1.14 .94', offset: 0.4 },
        { opacity: 0, scale: '.82 1.08', offset: 0.65 },
        { opacity: 0, scale: '.82 1.08' },
      ],
      { duration: 80, easing: 'linear', fill: 'backwards' },
    );
    const cuts = [
      '0 0, 50% 0, 48% 33%, 18% 42%, 0 35%',
      '50% 0, 100% 0, 100% 34%, 67% 39%, 48% 33%',
      '0 35%, 18% 42%, 48% 33%, 43% 58%, 0 62%',
      '48% 33%, 67% 39%, 100% 34%, 100% 61%, 57% 60%, 43% 58%',
      '0 62%, 43% 58%, 45% 78%, 16% 85%, 0 80%',
      '43% 58%, 57% 60%, 100% 61%, 100% 83%, 66% 86%, 45% 78%',
      '16% 85%, 45% 78%, 66% 86%, 70% 100%, 20% 100%',
    ];
    for (const [index, cut] of cuts.entries()) {
      const piece = document.createElement('i');
      piece.className = 'balloon-fragment';
      Object.assign(piece.style, {
        left: `${bounds.left - scene.left}px`,
        top: `${bounds.top - scene.top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        clipPath: `polygon(${cut})`,
      });
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 260 370');
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', '#balloon-envelope');
      svg.append(use);
      piece.append(svg);
      this.particles.append(piece);
      const x = (index % 2 ? 1 : -1) * (85 + (index % 3) * 48);
      const y = -95 + index * 27;
      motion.particle(
        piece,
        [
          { opacity: 0, transform: 'translate(0, 0) rotate(0) scale(1)' },
          {
            opacity: 1,
            transform: `translate(${x * 0.25}px, ${y * 0.25}px) rotate(${index % 2 ? 12 : -12}deg) scale(.95)`,
            offset: 0.12,
          },
          {
            opacity: 0.9,
            transform: `translate(${x}px, ${y}px) rotate(${(index - 3) * 25}deg) scale(.65)`,
            offset: 0.6,
          },
          {
            opacity: 0,
            transform: `translate(${x * 1.25}px, ${y + 150}px) rotate(${(index - 3) * 45}deg) scale(.35)`,
          },
        ],
        {
          duration: 980 + index * 35,
          delay: FLIGHT_TIMING.popImpactMs,
          easing: 'cubic-bezier(.15,.65,.4,1)',
          fill: 'backwards',
        },
      );
    }
    this.ripple(1120, FLIGHT_TIMING.popImpactMs);
    motion.play(
      this.wash,
      [{ opacity: 0 }, { opacity: 0.3, offset: 0.2 }, { opacity: 0 }],
      { duration: 560, delay: FLIGHT_TIMING.popImpactMs },
    );
    this.burst(
      motion,
      14,
      'pop-spark',
      155,
      880,
      FLIGHT_TIMING.popImpactMs,
      70,
    );
  }

  private cashout(): void {
    const motion = this.endingMotion;
    motion.play(
      this.flight,
      [
        { opacity: 1, translate: '0 0', rotate: '0deg', scale: '1' },
        {
          opacity: 1,
          translate: '12px -35px',
          rotate: '4deg',
          scale: '1.04',
          offset: 0.28,
        },
        {
          opacity: 0.8,
          translate: '80px -160px',
          rotate: '-5deg',
          scale: '.8',
          offset: 0.7,
        },
        {
          opacity: 0,
          translate: '150px -320px',
          rotate: '-10deg',
          scale: '.3',
        },
      ],
      { duration: 1250, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'backwards' },
    );
    this.ripple(1350);
    this.burst(motion, 20, 'cashout-spark', 200, 1600, 0, 105);
    this.walletTrail(0);
  }

  private summit(): void {
    const motion = this.endingMotion;
    const crown = find(this.root, '#crown-reveal');
    motion.play(
      this.flight,
      [
        { opacity: 1, translate: '0 0', scale: '1' },
        { opacity: 1, translate: '0 -45px', scale: '1.08', offset: 0.35 },
        { opacity: 0.85, translate: '0 -180px', scale: '.8', offset: 0.7 },
        { opacity: 0, translate: '0 -300px', scale: '.1' },
      ],
      { duration: 1750, easing: SPRING, fill: 'backwards' },
    );
    motion.play(
      crown,
      [
        {
          opacity: 0,
          transform: 'translate(-50%, -50%) scale(.35) rotate(-12deg)',
        },
        {
          opacity: 1,
          transform: 'translate(-50%, -60%) scale(1.06) rotate(2deg)',
          offset: 0.22,
        },
        {
          opacity: 1,
          transform: 'translate(-50%, -64%) scale(1) rotate(0)',
          offset: FLIGHT_TIMING.summitFlourishMs / 2400,
        },
        {
          opacity: 0,
          transform: 'translate(-50%, -84%) scale(1.18) rotate(0)',
        },
      ],
      { duration: 2400, easing: 'linear', fill: 'backwards' },
    );
    motion.play(
      find(this.root, '#crown-rays'),
      [
        { opacity: 0, rotate: '-15deg', scale: '.5' },
        {
          opacity: 0.8,
          rotate: '0deg',
          scale: '1',
          offset: FLIGHT_TIMING.summitFlourishMs / 2900,
        },
        { opacity: 0, rotate: '25deg', scale: '1.3' },
      ],
      { duration: 2900, easing: 'linear' },
    );
    this.ripple(2300);
    motion.play(
      this.wash,
      [
        { opacity: 0 },
        { opacity: 0.5, offset: FLIGHT_TIMING.summitFlourishMs / 2300 },
        { opacity: 0 },
      ],
      { duration: 2300, easing: 'linear' },
    );
    this.burst(motion, 36, 'summit-star', 310, 2850, 120, 140);
    this.burst(motion, 16, 'summit-ribbon', 240, 2700, 350, 240);
    this.walletTrail(
      FLIGHT_TIMING.summitFlourishMs - FLIGHT_TIMING.cashoutCoinMs,
    );
  }

  private ripple(duration: number, delay = 0): void {
    this.endingMotion.play(
      this.ring,
      [
        {
          opacity: 0,
          transform: 'translate(-50%, -50%) scale(.2) rotate(-12deg)',
        },
        {
          opacity: 0.9,
          transform: 'translate(-50%, -50%) scale(.55) rotate(0)',
          offset: 0.18,
        },
        {
          opacity: 0,
          transform: 'translate(-50%, -50%) scale(1.5) rotate(12deg)',
        },
      ],
      { duration, delay, easing: EASE_OUT, fill: 'backwards' },
    );
  }

  private burst(
    motion: MotionGroup,
    count: number,
    kind: string,
    radius: number,
    duration: number,
    delay = 0,
    fall = 0,
  ): void {
    for (let index = 0; index < count; index++) {
      const piece = document.createElement('i');
      piece.className = `flight-particle ${kind}`;
      piece.style.setProperty(
        '--particle-color',
        ['#fff1cc', '#f6c981', '#c9b6ff', '#b7f6df'][index % 4]!,
      );
      this.particles.append(piece);
      const angle = index * 2.39996;
      const spread = radius * (0.5 + (index % 5) * 0.12);
      const x = Math.cos(angle) * spread;
      const y = Math.sin(angle) * spread;
      motion.particle(
        piece,
        [
          { opacity: 0, transform: 'translate(0, 0) rotate(0) scale(.2)' },
          {
            opacity: 1,
            transform: `translate(${x * 0.3}px, ${y * 0.3}px) rotate(${index * 17}deg) scale(1)`,
            offset: 0.18,
          },
          {
            opacity: 0.8,
            transform: `translate(${x * 0.8}px, ${y * 0.8 + fall * 0.2}px) rotate(${index * 31}deg) scale(.85)`,
            offset: 0.65,
          },
          {
            opacity: 0,
            transform: `translate(${x}px, ${y + fall}px) rotate(${index * 53}deg) scale(.2)`,
          },
        ],
        {
          duration: duration + (index % 3) * 70,
          delay: delay + (index % 4) * 25,
          easing: EASE_OUT,
          fill: 'backwards',
        },
      );
    }
  }

  private walletTrail(delay: number): void {
    const wallet = document.querySelector<HTMLElement>('.wallet');
    if (!wallet) return;
    // Settlement may measure its endpoints; pumping performs no layout reads.
    const from = this.balloon.getBoundingClientRect();
    const to = wallet.getBoundingClientRect();
    const x = from.left + from.width / 2;
    const y = from.top + from.height * 0.35;
    const dx = to.left + to.width / 2 - x;
    const dy = to.top + to.height / 2 - y;
    const layer = this.endingMotion.own(document.createElement('div'));
    layer.className = 'wallet-trails';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
    for (let index = 0; index < 9; index++) {
      const coin = document.createElement('i');
      coin.className = 'wallet-coin';
      coin.style.left = `${x}px`;
      coin.style.top = `${y}px`;
      layer.append(coin);
      this.endingMotion.particle(
        coin,
        [
          { opacity: 0, transform: 'translate(-50%, -50%) scale(.3)' },
          {
            opacity: 1,
            transform: `translate(${dx * 0.12 - 30 + index * 7}px, ${dy * 0.32 - 60}px) scale(1.1)`,
            offset: 0.3,
          },
          {
            opacity: 0.9,
            transform: `translate(${dx * 0.68}px, ${dy * 0.84 - 45}px) scale(.75)`,
            offset: 0.75,
          },
          { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.2)` },
        ],
        {
          duration: FLIGHT_TIMING.cashoutCoinMs,
          delay: delay + index * 45,
          easing: 'ease-in-out',
          fill: 'backwards',
        },
      );
    }
    this.endingMotion.play(
      wallet,
      [{ scale: '1' }, { scale: '1.055', offset: 0.4 }, { scale: '1' }],
      {
        duration: 550,
        delay: delay + FLIGHT_TIMING.cashoutCoinMs,
        easing: SPRING,
      },
    );
    void this.endingMotion.finished().then(() => layer.remove());
  }
}
