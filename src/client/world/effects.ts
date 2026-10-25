import type { RoundView } from '../../shared/types.js';
import { MAX_PUMPS } from '../../shared/settings.js';
import {
  getBackdropSegments,
  PRELOAD_PUMPS,
  SUMMIT_EFFECTS_START_PUMP,
} from '../flight-model.js';
import type { CameraView } from './camera.js';
import { find } from './dom.js';
type Scene = ReturnType<typeof getBackdropSegments>[number];
interface Effect {
  element: HTMLElement;
  bottom: number;
  height: number;
  size: number;
  topAnchored: boolean;
  depth: number;
  assetsLoaded: boolean;
}

export class WorldEffects {
  private readonly balloon: HTMLElement;
  private readonly flight: HTMLElement;
  private readonly particles: HTMLElement;
  private readonly summit: HTMLElement;
  private readonly effects: Effect[] = [];
  private readonly habitatBounds = new WeakMap<HTMLElement, Scene>();
  private readonly depths = new WeakMap<HTMLElement, number>();
  private readonly animations = new Set<Animation>();
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );
  private motionTimer: ReturnType<typeof setTimeout> | undefined;
  private settling = false;
  private settlementId = 0;
  constructor(
    private readonly root: HTMLElement,
    private readonly onSettlementChange: () => void,
  ) {
    this.balloon = find(root, '#balloon');
    this.flight = find(root, '#balloon-flight');
    this.particles = find(root, '#scene-particles');
    this.createAmbience();
    this.summit = this.createSummit();
    const pause = () => {
      root.toggleAttribute('data-paused', document.hidden);
      for (const animation of this.animations) {
        if (document.hidden) animation.pause();
        else if (animation.playState === 'paused') animation.play();
      }
    };
    document.addEventListener('visibilitychange', pause);
    pause();
    this.reducedMotion.addEventListener('change', () => {
      if (!this.reducedMotion.matches) return;
      root
        .getAnimations({ subtree: true })
        .forEach((animation) => animation.cancel());
      this.reset();
    });
  }

  get isSettling(): boolean {
    return this.settling;
  }
  private setSettling(settling: boolean): void {
    if (this.settling === settling) return;
    this.settling = settling;
    this.root.toggleAttribute('data-settling', settling);
    this.onSettlementChange();
  }

  reset(): void {
    this.settlementId++;
    // Cleanup is unconditional; only creating animations depends on reduced motion.
    this.clearTransient();
    this.setSettling(false);
  }

  private clearTransient(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    this.particles.replaceChildren();
    clearTimeout(this.motionTimer);
    delete this.root.dataset.moving;
  }
  private trackEffect(
    element: HTMLElement,
    bottom: number,
    height = 0,
    size = 30,
    topAnchored = false,
  ): void {
    element.classList.add('world-effect');
    this.effects.push({
      element,
      bottom,
      height,
      size,
      topAnchored,
      depth: element.parentElement
        ? (this.depths.get(element.parentElement) ?? 0)
        : 0,
      assetsLoaded: false,
    });
  }

  updateView(view: CameraView): void {
    const {
      worldHeight,
      maxOffset,
      height,
      cameraOffset,
      motionBottom,
      pumps,
    } = view;
    const viewBottom = motionBottom - 120;
    const viewTop = cameraOffset + height + 120;
    const preloadTop = viewTop + (maxOffset / MAX_PUMPS) * PRELOAD_PUMPS;
    for (const effect of this.effects) {
      const parallax = cameraOffset * effect.depth;
      const bottom =
        effect.bottom * worldHeight -
        parallax -
        (effect.topAnchored ? effect.size : 0);
      const top =
        (effect.bottom + effect.height) * worldHeight -
        parallax +
        (effect.topAnchored ? 0 : effect.size);
      effect.element.toggleAttribute(
        'data-active',
        bottom < viewTop && top > viewBottom,
      );
      if (!effect.assetsLoaded && bottom < preloadTop && top > viewBottom) {
        for (const sprite of effect.element.querySelectorAll<HTMLElement>(
          '[data-sprite]',
        )) {
          sprite.style.backgroundImage = `url('/art/sprites/${sprite.dataset.sprite}-atlas.png?v=2')`;
        }
        effect.assetsLoaded = true;
      }
    }
    this.summit.toggleAttribute(
      'data-active',
      pumps > SUMMIT_EFFECTS_START_PUMP,
    );
  }

  private animate(
    element: HTMLElement,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): Animation {
    const animation = element.animate(frames, options);
    this.animations.add(animation);
    void animation.finished.then(
      () => this.animations.delete(animation),
      () => this.animations.delete(animation),
    );
    if (document.hidden) animation.pause();
    return animation;
  }

  pump(): void {
    if (this.reducedMotion.matches) return;
    this.root.dataset.moving = 'true';
    clearTimeout(this.motionTimer);
    this.motionTimer = setTimeout(() => delete this.root.dataset.moving, 1000);
    this.balloon.getAnimations().forEach((animation) => animation.cancel());
    this.animate(
      this.balloon,
      [
        { scale: '1 1' },
        { scale: '1.12 .94', offset: 0.28 },
        { scale: '.97 1.05', offset: 0.62 },
        { scale: '1 1' },
      ],
      { duration: 620, easing: 'cubic-bezier(.22,.7,.25,1)' },
    );
    this.animate(
      find(this.root, '#pump-ripple'),
      [
        { opacity: 0.5, transform: 'translate(-50%, -50%) scale(.75)' },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(1.65)' },
      ],
      { duration: 800, easing: 'ease-out' },
    );
  }

  settle(round: RoundView): void {
    this.clearTransient();
    if (this.reducedMotion.matches) return;
    const settlementId = ++this.settlementId;
    this.setSettling(true);
    const popped = round.status === 'popped';
    const summit = !popped && round.settlementReason === 'limit';
    this.animate(
      this.flight,
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
      const animation = this.animate(
        piece,
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
      // Cancelled particles must leave the DOM too, including preference changes.
      void animation.finished.then(
        () => piece.remove(),
        () => piece.remove(),
      );
    }
    if (summit) {
      this.animate(
        this.summit,
        [{ opacity: 0.15 }, { opacity: 0.95, offset: 0.65 }, { opacity: 0.8 }],
        { duration: 1900, easing: 'ease-out' },
      );
    }
    this.animate(
      find(this.root, '#result-banner'),
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
    // A cancellation (including reduced motion) also releases the UI lock.
    void Promise.allSettled(
      [...this.animations].map((animation) => animation.finished),
    ).then(() => {
      if (settlementId === this.settlementId) this.setSettling(false);
    });
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
      this.trackEffect(star, 1 - (((index * 13) % 34) + 1) / 100, 0, 14, true);
    }
    for (let index = 0; index < 6; index++) {
      const cloud = document.createElement('i');
      cloud.className = 'drifting-cloud';
      cloud.style.top = `${42 + index * 7}%`;
      cloud.style.left = index % 2 ? '47%' : '-22%';
      cloud.style.setProperty('--delay', `${-index * 9}s`);
      cloud.style.setProperty('--duration', `${35 + index * 3}s`);
      middle.append(cloud);
      this.trackEffect(cloud, 1 - (42 + index * 7) / 100, 0, 130, true);
    }
    for (let index = 0; index < 12; index++) {
      const mote = document.createElement('i');
      mote.className = 'meadow-mote';
      mote.style.left = `${(index * 17 + 5) % 100}%`;
      mote.style.bottom = `${1 + ((index * 7) % 11)}%`;
      mote.style.setProperty('--delay', `${-index * 1.2}s`);
      near.append(mote);
      this.trackEffect(mote, (1 + ((index * 7) % 11)) / 100, 0, 3);
    }
    for (let index = 0; index < 5; index++) {
      const meteor = document.createElement('i');
      meteor.className = 'shooting-star';
      meteor.style.top = `${4 + index * 6}%`;
      meteor.style.left = `${3 + index * 11}%`;
      meteor.style.setProperty('--delay', `${-index * 3.3}s`);
      far.append(meteor);
      this.trackEffect(meteor, 1 - (4 + index * 6) / 100, 0, 400, true);
    }
    const aurora = document.createElement('div');
    aurora.className = 'aurora-curtains';
    far.append(aurora);
    this.trackEffect(aurora, 0.58, 0.34, 0);
    for (let index = 0; index < 9; index++) {
      const crystal = document.createElement('i');
      crystal.className = 'floating-crystal';
      crystal.style.left = `${index % 2 ? 84 - index * 2 : 5 + index * 2}%`;
      crystal.style.top = `${5 + index * 3}%`;
      crystal.style.setProperty('--delay', `${-index * 1.7}s`);
      crystal.style.setProperty('--crystal-size', `${10 + (index % 4) * 4}px`);
      near.append(crystal);
      this.trackEffect(crystal, 1 - (5 + index * 3) / 100, 0, 40, true);
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
    this.habitatBounds.set(habitat, scene);
    this.depths.set(habitat, this.depths.get(parent) ?? 0);
    this.trackEffect(habitat, scene.bottom, scene.height, 0);
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
    summit.className = 'summit-effects world-effect';
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
    this.depths.set(layer, depth);
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
    const habitat = this.habitatBounds.get(parent);
    const bottom =
      (habitat?.bottom ?? 0) +
      (habitat?.height ?? 1) * (fromBottom ? y / 100 : 1 - y / 100);
    this.trackEffect(traveller, bottom, 0, size, !fromBottom);
  }
}
