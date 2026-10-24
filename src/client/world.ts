import type { RoundView } from '../shared/types.js';
import {
  BACKDROP_OVERLAP,
  FLIGHT_ZONES,
  getBackdropSegments,
  getFlightZone,
  getWorldLayout,
  getWorldAtmosphere,
} from './flight-model.js';

function find<T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing world element: ${selector}`);
  return element;
}

export class FlightWorld {
  private readonly map: HTMLElement;
  private readonly balloon: HTMLElement;
  private readonly flight: HTMLElement;
  private readonly particles: HTMLElement;
  private readonly summit: HTMLElement;
  private readonly backdrops: HTMLElement[] = [];
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );
  private round: RoundView | null = null;
  private initialized = false;
  private motionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly root: HTMLElement) {
    this.map = find(root, '#world-map');
    this.balloon = find(root, '#balloon');
    this.flight = find(root, '#balloon-flight');
    this.particles = find(root, '#scene-particles');
    this.createBackdrops();
    this.createAmbience();
    this.summit = this.createSummit();
    document.addEventListener('visibilitychange', () => {
      root.toggleAttribute('data-paused', document.hidden);
    });
    this.reducedMotion.addEventListener('change', () => {
      if (this.reducedMotion.matches) {
        root
          .getAnimations({ subtree: true })
          .forEach((animation) => animation.cancel());
      }
    });
    new ResizeObserver(() => this.layout(true)).observe(root);
    const segments = document.querySelector('#journey-segments');
    for (let pump = 1; pump <= 25; pump++) {
      const segment = document.createElement('i');
      segment.dataset.pump = String(pump);
      segments?.append(segment);
    }
    const landmarks = document.querySelector('.journey-landmarks');
    landmarks?.replaceChildren();
    for (const zone of FLIGHT_ZONES) {
      const landmark = document.createElement('span');
      landmark.dataset.milestone = String(zone.pump);
      landmark.textContent = zone.shortName;
      landmarks?.append(landmark);
    }
    this.layout(true);
  }

  update(round: RoundView | null, instant = false): void {
    const previous = this.round;
    const changedRound = previous?.id !== round?.id;
    const pumped =
      !changedRound && (round?.pumps ?? 0) > (previous?.pumps ?? 0);
    const settled =
      round &&
      round.status !== 'active' &&
      (changedRound || previous?.status === 'active');
    this.round = round;
    const pumps = round?.pumps ?? 0;
    const zone = getFlightZone(pumps);
    const atmosphere = getWorldAtmosphere(pumps);
    const reachedSummit =
      round?.status === 'cashed_out' &&
      round.settlementReason === 'limit' &&
      pumps === 25;
    this.root.dataset.status = round?.status ?? 'ready';
    this.root.dataset.zone = String(zone.index);
    this.root.dataset.environment = zone.id;
    this.root.toggleAttribute('data-summit', reachedSummit);
    this.root
      .closest('.flight-panel')
      ?.classList.toggle('is-summit', reachedSummit);
    this.root.style.setProperty('--wonder', String(atmosphere.wonder));
    this.root.style.setProperty('--crown-glow', String(atmosphere.crownGlow));
    this.root.style.setProperty('--ascent', String(pumps / 25));
    this.root.style.setProperty('--sway-duration', `${5 - pumps * 0.09}s`);
    this.balloon.style.setProperty(
      '--balloon-scale',
      String(0.72 + pumps * 0.018),
    );
    this.balloon.setAttribute(
      'aria-label',
      round?.status === 'popped'
        ? `Balloon popped on pump ${pumps}`
        : `Balloon after ${pumps} pumps`,
    );
    find(this.root, '#environment-name').textContent = zone.name;
    find(this.root, '#world-coordinate').textContent =
      `WORLD ${String(zone.index + 1).padStart(2, '0')} / ${String(FLIGHT_ZONES.length).padStart(2, '0')}`;
    find(this.root, '#altimeter').setAttribute('aria-valuenow', String(pumps));
    find(this.root, '#altimeter').setAttribute(
      'aria-valuetext',
      `${pumps} of 25 pumps. ${zone.name}.`,
    );
    document
      .querySelectorAll<HTMLElement>('#journey-segments i')
      .forEach((segment) => {
        const pump = Number(segment.dataset.pump);
        segment.classList.toggle('is-reached', pump <= pumps);
        segment.classList.toggle(
          'is-pop',
          round?.status === 'popped' && pump === pumps,
        );
      });
    document
      .querySelectorAll<HTMLElement>('[data-milestone]')
      .forEach((landmark) => {
        const milestone = Number(landmark.dataset.milestone);
        landmark.classList.toggle('is-current', milestone === zone.pump);
        landmark.classList.toggle('is-reached', milestone <= pumps);
      });
    const caption = document.querySelector('#journey-caption');
    if (caption) caption.textContent = zone.caption;
    this.layout(instant || !this.initialized);

    if (this.initialized && !instant && !this.reducedMotion.matches) {
      if (changedRound) {
        this.particles.replaceChildren();
        this.flight.getAnimations().forEach((animation) => animation.cancel());
        this.balloon.getAnimations().forEach((animation) => animation.cancel());
      }
      if (pumped) this.animatePump();
      if (settled && round) this.animateSettlement(round);
    }
    this.initialized = true;
  }

  private layout(instant: boolean): void {
    const { width, height } = this.root.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const layout = getWorldLayout(width, height, this.round?.pumps ?? 0);
    if (instant) this.root.dataset.instant = 'true';
    this.map.style.height = `${layout.worldHeight}px`;
    this.map.style.transform = `translate3d(0, ${layout.offset}px, 0)`;
    this.root.style.setProperty('--camera-offset', `${layout.offset}px`);
    this.root.style.setProperty('--viewport-width', `${width}px`);
    this.root.style.setProperty('--viewport-height', `${height}px`);
    getBackdropSegments(layout.worldHeight).forEach((segment, index) => {
      const backdrop = this.backdrops[index];
      if (!backdrop) throw new Error('Backdrop element is missing.');
      backdrop.style.height = `${segment.height}px`;
      backdrop.style.bottom = `${segment.bottom}px`;
    });
    this.root.dataset.cameraOffset = String(layout.offset);
    this.root.dataset.cameraMax = String(layout.maxOffset);
    if (instant)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          delete this.root.dataset.instant;
        }),
      );
  }

  private createBackdrops(): void {
    const container = find(this.root, '#world-backdrops');
    for (const [index, segment] of getBackdropSegments(1).entries()) {
      const backdrop = document.createElement('div');
      backdrop.className = 'world-biome';
      backdrop.dataset.biome = segment.id;
      backdrop.style.backgroundColor = segment.color;
      backdrop.style.setProperty('--blend-stop', `${BACKDROP_OVERLAP * 100}%`);
      const image = document.createElement('img');
      image.className = 'world-art';
      image.alt = '';
      image.width = 1536;
      image.height = 1024;
      image.decoding = 'async';
      image.fetchPriority = index === 0 ? 'high' : 'low';
      image.addEventListener(
        'load',
        () => backdrop.classList.add('is-loaded'),
        { once: true },
      );
      image.src = segment.src;
      if (segment.mobileSrc) {
        const picture = document.createElement('picture');
        const source = document.createElement('source');
        source.media = '(max-width: 760px)';
        source.srcset = segment.mobileSrc;
        picture.append(source, image);
        backdrop.append(picture);
      } else {
        backdrop.append(image);
      }
      container.append(backdrop);
      this.backdrops.push(backdrop);
    }
  }

  private animatePump(): void {
    this.root.dataset.moving = 'true';
    clearTimeout(this.motionTimer);
    this.motionTimer = setTimeout(() => delete this.root.dataset.moving, 1000);
    this.balloon.getAnimations().forEach((animation) => animation.cancel());
    this.balloon.animate(
      [
        { scale: '1 1' },
        { scale: '1.12 .94', offset: 0.28 },
        { scale: '.97 1.05', offset: 0.62 },
        { scale: '1 1' },
      ],
      { duration: 620, easing: 'cubic-bezier(.22,.7,.25,1)' },
    );
    find(this.root, '#pump-ripple').animate(
      [
        { opacity: 0.5, transform: 'translate(-50%, -50%) scale(.75)' },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(1.65)' },
      ],
      { duration: 800, easing: 'ease-out' },
    );
  }

  private animateSettlement(round: RoundView): void {
    const popped = round.status === 'popped';
    const summit = !popped && round.settlementReason === 'limit';
    this.balloon.getAnimations().forEach((animation) => animation.cancel());
    this.flight.getAnimations().forEach((animation) => animation.cancel());
    this.flight.animate(
      popped
        ? [
            { opacity: 1, transform: 'scale(1)' },
            { opacity: 0.8, transform: 'scale(1.16)', offset: 0.35 },
            { opacity: 0, transform: 'scale(.2)' },
          ]
        : [
            { opacity: 1, transform: 'translateY(0) rotate(0)' },
            {
              opacity: 1,
              transform: 'translateY(-90px) rotate(5deg)',
              offset: 0.35,
            },
            { opacity: 0, transform: 'translateY(-540px) rotate(-7deg)' },
          ],
      {
        duration: popped ? 230 : 1500,
        easing: popped ? 'ease-out' : 'cubic-bezier(.3,0,.4,1)',
      },
    );

    this.particles.replaceChildren();
    for (let index = 0; index < (popped ? 12 : summit ? 44 : 24); index++) {
      const piece = document.createElement('i');
      piece.className = popped ? 'balloon-fragment' : 'win-confetti';
      piece.style.background = summit
        ? ['#ffe3aa', '#fff8df', '#e4c9ff', '#f2d291'][index % 4]!
        : popped
          ? ['#ff9b7d', '#f56560', '#ffcfb5'][index % 3]!
          : ['#7be3bf', '#ffe2a5', '#cbb7ff', '#f7fbff'][index % 4]!;
      this.particles.append(piece);
      const angle = index * 2.39996;
      const radius = popped ? 90 + (index % 4) * 20 : 140 + (index % 5) * 36;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const animation = piece.animate(
        [
          { opacity: 0, transform: 'translate(0, 0) rotate(0) scale(.4)' },
          {
            opacity: 1,
            transform: `translate(${x * 0.6}px, ${y * 0.6}px) rotate(${index * 27}deg) scale(1)`,
            offset: 0.28,
          },
          {
            opacity: 0,
            transform: `translate(${x}px, ${y + (popped ? 70 : 170)}px) rotate(${index * 51}deg) scale(.6)`,
          },
        ],
        {
          duration: popped ? 650 : summit ? 2400 : 1700,
          delay: popped ? 0 : 150,
          easing: 'ease-out',
        },
      );
      animation.onfinish = () => piece.remove();
    }
    if (summit) {
      this.summit.animate(
        [{ opacity: 0.15 }, { opacity: 0.95, offset: 0.65 }, { opacity: 0.8 }],
        { duration: 1900, easing: 'ease-out' },
      );
    }
    find(this.root, '#result-banner').animate(
      [
        { opacity: 0, transform: 'translate(-50%, -40%) scale(.92)' },
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
      ],
      {
        duration: 500,
        delay: popped ? 120 : 280,
        easing: 'cubic-bezier(.2,.8,.2,1)',
        fill: 'backwards',
      },
    );
  }

  private createAmbience(): void {
    const ambience = find(this.root, '#world-ambience');
    const far = this.createLayer(ambience, 'far', -0.055);
    const middle = this.createLayer(ambience, 'middle', -0.02);
    const near = this.createLayer(ambience, 'near', 0.025);
    for (let index = 0; index < 48; index++) {
      const star = document.createElement('i');
      star.className = 'world-star';
      star.style.left = `${(index * 29 + 7) % 96}%`;
      star.style.top = `${((index * 13) % 34) + 1}%`;
      star.style.setProperty('--delay', `${-(index % 7)}s`);
      star.style.setProperty('--duration', `${3 + (index % 5)}s`);
      if (index % 5 === 0) star.classList.add('star-cross');
      far.append(star);
    }
    for (let index = 0; index < 6; index++) {
      const cloud = document.createElement('i');
      cloud.className = 'drifting-cloud';
      cloud.style.top = `${42 + index * 7}%`;
      cloud.style.left = index % 2 ? '47%' : '-22%';
      cloud.style.setProperty('--delay', `${-index * 9}s`);
      cloud.style.setProperty('--duration', `${35 + index * 3}s`);
      middle.append(cloud);
    }
    for (let index = 0; index < 12; index++) {
      const mote = document.createElement('i');
      mote.className = 'meadow-mote';
      mote.style.left = `${(index * 17 + 5) % 100}%`;
      mote.style.bottom = `${1 + ((index * 7) % 11)}%`;
      mote.style.setProperty('--delay', `${-index * 1.2}s`);
      near.append(mote);
    }
    for (let index = 0; index < 5; index++) {
      const meteor = document.createElement('i');
      meteor.className = 'shooting-star';
      meteor.style.top = `${4 + index * 6}%`;
      meteor.style.left = `${3 + index * 11}%`;
      meteor.style.setProperty('--delay', `${-index * 3.3}s`);
      far.append(meteor);
    }
    const aurora = document.createElement('div');
    aurora.className = 'aurora-curtains';
    far.append(aurora);
    for (let index = 0; index < 9; index++) {
      const crystal = document.createElement('i');
      crystal.className = 'floating-crystal';
      crystal.style.left = `${index % 2 ? 84 - index * 2 : 5 + index * 2}%`;
      crystal.style.top = `${5 + index * 3}%`;
      crystal.style.setProperty('--delay', `${-index * 1.7}s`);
      crystal.style.setProperty('--crystal-size', `${10 + (index % 4) * 4}px`);
      near.append(crystal);
    }

    for (const butterfly of [
      { x: 11, y: 4, size: 50, delay: -3, duration: 13 },
      { x: 76, y: 7, size: 43, delay: -8, duration: 17 },
      { x: 39, y: 2, size: 36, delay: -5, duration: 15 },
      { x: 17, y: 13, size: 32, delay: -12, duration: 19 },
    ]) {
      this.createCreature(
        near,
        'butterfly',
        butterfly.x,
        butterfly.y,
        butterfly.size,
        butterfly.delay,
        butterfly.duration,
        true,
      );
    }
    for (const ray of [
      { y: 8, size: 100, delay: -6, duration: 38 },
      { y: 17, size: 72, delay: -22, duration: 44 },
      { y: 29, size: 86, delay: -13, duration: 36 },
      { y: 48, size: 65, delay: -18, duration: 48 },
      { y: 66, size: 75, delay: -9, duration: 40 },
    ]) {
      this.createCreature(
        middle,
        'sky-ray',
        -18,
        ray.y,
        ray.size,
        ray.delay,
        ray.duration,
        false,
      );
    }
    this.createHabitats(middle, near);
  }

  private createHabitat(parent: HTMLElement, id: string): HTMLElement {
    const scene = getBackdropSegments(1).find((segment) => segment.id === id);
    if (!scene) throw new Error(`Missing habitat: ${id}`);
    const habitat = document.createElement('div');
    habitat.className = `habitat-effects habitat-${id}`;
    habitat.style.bottom = `${scene.bottom * 100}%`;
    habitat.style.height = `${scene.height * 100}%`;
    parent.append(habitat);
    return habitat;
  }

  private createHabitats(middle: HTMLElement, near: HTMLElement): void {
    const crystal = this.createHabitat(near, 'crystal-expanse');
    const tempest = this.createHabitat(middle, 'tempest-sea');
    const gardens = this.createHabitat(near, 'aurora-gardens');
    const ruins = this.createHabitat(middle, 'celestial-ruins');
    const gate = this.createHabitat(middle, 'stargate');
    const crown = this.createHabitat(middle, 'astral-crown');
    for (let index = 0; index < 18; index++) {
      const glint = document.createElement('i');
      glint.className = 'prism-glint';
      glint.style.left = `${index % 2 ? 75 + (index % 20) : 4 + (index % 20)}%`;
      glint.style.top = `${12 + ((index * 17) % 76)}%`;
      glint.style.setProperty('--delay', `${-index * 0.7}s`);
      crystal.append(glint);
    }
    for (let index = 0; index < 3; index++) {
      const mist = document.createElement('i');
      mist.className = 'tempest-mist';
      mist.style.top = `${20 + index * 21}%`;
      mist.style.setProperty('--delay', `${-index * 6}s`);
      tempest.append(mist);
    }
    for (let index = 0; index < 16; index++) {
      const petal = document.createElement('i');
      petal.className = 'aurora-petal';
      petal.style.left = `${(index * 23) % 100}%`;
      petal.style.top = `${15 + ((index * 13) % 70)}%`;
      petal.style.setProperty('--delay', `${-index * 0.9}s`);
      petal.style.setProperty('--duration', `${7 + (index % 5)}s`);
      gardens.append(petal);
    }
    for (let index = 0; index < 6; index++) {
      const orbital = document.createElement('span');
      orbital.className = 'orbital-wisp';
      orbital.style.left = `${index % 2 ? 78 : 9 + index * 3}%`;
      orbital.style.top = `${15 + index * 12}%`;
      orbital.style.setProperty('--delay', `${-index * 4}s`);
      orbital.append(document.createElement('i'));
      ruins.append(orbital);
    }
    for (let index = 0; index < 12; index++) {
      const current = document.createElement('i');
      current.className = 'gate-current';
      current.style.left = `${6 + ((index * 29) % 89)}%`;
      current.style.top = `${20 + ((index * 17) % 60)}%`;
      current.style.setProperty('--delay', `${-index * 1.2}s`);
      gate.append(current);
    }
    this.createCreature(gate, 'crown-whale', -18, 52, 105, -21, 58, false);
    this.createCreature(crown, 'crown-whale', -18, 32, 172, -17, 65, false);
    this.createCreature(crown, 'crown-whale', -18, 64, 110, -35, 73, false);
  }

  private createSummit(): HTMLElement {
    const summit = document.createElement('div');
    summit.id = 'summit-effects';
    summit.className = 'summit-effects';
    summit.setAttribute('aria-hidden', 'true');
    const halo = document.createElement('div');
    halo.className = 'crown-halo';
    summit.append(halo);
    for (let index = 0; index < 36; index++) {
      const star = document.createElement('i');
      star.className = 'crown-starfall';
      star.style.left = `${(index * 37) % 100}%`;
      star.style.setProperty('--delay', `${-index * 0.43}s`);
      star.style.setProperty('--duration', `${6 + (index % 5)}s`);
      star.style.setProperty('--size', `${index % 4 === 0 ? 4 : 2}px`);
      summit.append(star);
    }
    this.root.append(summit);
    return summit;
  }

  private createLayer(
    parent: HTMLElement,
    name: string,
    depth: number,
  ): HTMLElement {
    const layer = document.createElement('div');
    layer.className = `world-depth world-depth-${name}`;
    layer.style.setProperty('--parallax-depth', String(depth));
    parent.append(layer);
    return layer;
  }

  private createCreature(
    parent: HTMLElement,
    kind: 'butterfly' | 'sky-ray' | 'crown-whale',
    x: number,
    y: number,
    size: number,
    delay: number,
    duration: number,
    fromBottom: boolean,
  ): void {
    const traveller = document.createElement('div');
    traveller.className = `world-creature creature-${kind}`;
    traveller.style.left = `${x}%`;
    traveller.style[fromBottom ? 'bottom' : 'top'] = `${y}%`;
    traveller.style.setProperty('--creature-size', `${size}px`);
    traveller.style.setProperty('--travel-delay', `${delay}s`);
    traveller.style.setProperty('--travel-duration', `${duration}s`);
    const sprite = document.createElement('div');
    sprite.className = `sprite-atlas sprite-${kind}`;
    sprite.dataset.sprite = kind;
    sprite.style.setProperty('--frame-delay', `${delay / 9}s`);
    traveller.append(sprite);
    parent.append(traveller);
  }
}
