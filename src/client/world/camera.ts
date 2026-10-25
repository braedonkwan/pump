import { MAX_PUMPS } from '../../shared/settings.js';
import type { WorldGeometry } from './geometry.js';
import { FLIGHT_TIMING } from '../flight-timing.js';
const CAMERA_DURATION_MS = FLIGHT_TIMING.pumpMs;
const CAMERA_SETTLE_MS = CAMERA_DURATION_MS + 50;
export interface CameraView {
  worldHeight: number;
  maxOffset: number;
  height: number;
  cameraOffset: number;
  motionBottom: number;
  pumps: number;
}

export class WorldCamera {
  private cameraOffset = 0;
  private motionBottom = 0;
  private recentOffsets: { offset: number; time: number }[] = [];
  private activityTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly root: HTMLElement,
    private readonly geometry: WorldGeometry,
    private readonly onViewChange: (view: CameraView) => void,
  ) {
    root.style.setProperty('--camera-duration', `${CAMERA_DURATION_MS}ms`);
  }

  resize(pumps: number): void {
    // Settlement can resize the panel while the final ascent is still running.
    this.move(pumps, this.activityTimer === undefined);
  }

  move(pumps: number, instant: boolean): void {
    const { width, height, maxOffset, map } = this.geometry;
    if (!width || !height) return;
    const offset = maxOffset * (pumps / MAX_PUMPS);
    if (instant) this.root.dataset.instant = 'true';
    if (instant) {
      this.recentOffsets = [];
      this.motionBottom = offset;
    } else {
      const now = performance.now();
      // Retain outgoing effects during the camera transition, including rapid pumps.
      this.recentOffsets = this.recentOffsets.filter(
        (entry) => now - entry.time < CAMERA_SETTLE_MS,
      );
      this.recentOffsets.push({ offset: this.cameraOffset, time: now });
      this.motionBottom = Math.min(
        offset,
        ...this.recentOffsets.map((entry) => entry.offset),
      );
    }
    this.cameraOffset = offset;
    map.style.transform = `translate3d(0, ${offset}px, 0)`;
    this.root.style.setProperty('--camera-offset', `${offset}px`);
    this.root.dataset.cameraOffset = String(offset);
    this.geometry.load(pumps);
    const updateView = () =>
      this.onViewChange({
        worldHeight: this.geometry.worldHeight,
        height: this.geometry.height,
        maxOffset: this.geometry.maxOffset,
        cameraOffset: this.cameraOffset,
        motionBottom: this.motionBottom,
        pumps,
      });
    updateView();
    clearTimeout(this.activityTimer);
    this.activityTimer = undefined;
    if (!instant)
      this.activityTimer = setTimeout(() => {
        this.activityTimer = undefined;
        this.motionBottom = this.cameraOffset;
        this.recentOffsets = [];
        updateView();
      }, CAMERA_SETTLE_MS);
    if (instant)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          delete this.root.dataset.instant;
        }),
      );
  }
}
