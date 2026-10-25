import type { RoundView } from '../shared/types.js';
import { MAX_PUMPS } from '../shared/settings.js';
import {
  FLIGHT_ZONES,
  getFlightZone,
  getWorldAtmosphere,
} from './flight-model.js';
import { find } from './world/dom.js';
import { WorldGeometry } from './world/geometry.js';
import { WorldCamera } from './world/camera.js';
import { WorldEffects } from './world/effects.js';

// Coordinate round presentation; geometry, camera transitions, and effects own their work.
export class FlightWorld {
  private readonly geometry: WorldGeometry;
  private readonly camera: WorldCamera;
  private readonly effects: WorldEffects;
  private readonly balloon: HTMLElement;
  private readonly segments: HTMLElement[] = [];
  private readonly landmarks: HTMLElement[] = [];
  private readonly environmentName: HTMLElement;
  private readonly coordinate: HTMLElement;
  private readonly altimeter: HTMLElement;
  private readonly caption: HTMLElement | null;
  private round: RoundView | null = null;
  private initialized = false;

  constructor(
    private readonly root: HTMLElement,
    onSettlementChange: () => void = () => {},
  ) {
    this.balloon = find(root, '#balloon');
    this.environmentName = find(root, '#environment-name');
    this.coordinate = find(root, '#world-coordinate');
    this.altimeter = find(root, '#altimeter');
    this.caption = document.querySelector('#journey-caption');
    this.geometry = new WorldGeometry(root);
    this.effects = new WorldEffects(root, onSettlementChange);
    this.camera = new WorldCamera(root, this.geometry, (view) =>
      this.effects.updateView(view),
    );
    const segments = document.querySelector('#journey-segments');
    for (let pump = 1; pump <= MAX_PUMPS; pump++) {
      const segment = document.createElement('i');
      segment.dataset.pump = String(pump);
      segments?.append(segment);
      this.segments.push(segment);
    }
    const landmarks = document.querySelector('.journey-landmarks');
    landmarks?.replaceChildren();
    for (const zone of FLIGHT_ZONES) {
      const landmark = document.createElement('span');
      landmark.dataset.milestone = String(zone.pump);
      landmark.textContent = zone.shortName;
      landmarks?.append(landmark);
      this.landmarks.push(landmark);
    }

    this.geometry.observe(() => {
      if (this.initialized) this.camera.move(this.round?.pumps ?? 0, true);
    });
  }

  get isSettling(): boolean {
    return this.effects.isSettling;
  }
  update(round: RoundView | null, instant = false): void {
    const previous = this.round;
    if (
      this.initialized &&
      !instant &&
      previous?.id === round?.id &&
      previous?.version === round?.version &&
      previous?.status === round?.status
    )
      return;
    const wasInitialized = this.initialized;
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
      pumps === MAX_PUMPS;
    this.root.dataset.status = round?.status ?? 'ready';
    this.root.dataset.zone = String(zone.index);
    this.root.dataset.environment = zone.id;
    this.root.toggleAttribute('data-summit', reachedSummit);
    this.root
      .closest('.flight-panel')
      ?.classList.toggle('is-summit', reachedSummit);
    this.root.style.setProperty('--wonder', String(atmosphere.wonder));
    this.root.style.setProperty('--crown-glow', String(atmosphere.crownGlow));
    this.root.style.setProperty('--ascent', String(pumps / MAX_PUMPS));
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
    this.environmentName.textContent = zone.name;
    this.coordinate.textContent = `WORLD ${String(zone.index + 1).padStart(2, '0')} / ${String(FLIGHT_ZONES.length).padStart(2, '0')}`;
    this.altimeter.setAttribute('aria-valuenow', String(pumps));
    this.altimeter.setAttribute(
      'aria-valuetext',
      `${pumps} of ${MAX_PUMPS} pumps. ${zone.name}.`,
    );
    this.segments.forEach((segment) => {
      const pump = Number(segment.dataset.pump);
      segment.classList.toggle('is-reached', pump <= pumps);
      segment.classList.toggle(
        'is-pop',
        round?.status === 'popped' && pump === pumps,
      );
    });
    this.landmarks.forEach((landmark) => {
      const milestone = Number(landmark.dataset.milestone);
      landmark.classList.toggle('is-current', milestone === zone.pump);
      landmark.classList.toggle('is-reached', milestone <= pumps);
    });
    if (this.caption) this.caption.textContent = zone.caption;
    if (changedRound) this.effects.reset();
    this.initialized = true;
    this.camera.move(pumps, instant || !wasInitialized || changedRound);

    if (wasInitialized && !instant) {
      if (pumped) this.effects.pump();
      if (settled && round) this.effects.settle(round);
    }
  }
}
