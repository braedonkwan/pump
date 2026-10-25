import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { FLIGHT_TIMING } from '../src/client/flight-timing.js';
import { WorldCamera, type CameraView } from '../src/client/world/camera.js';
import type { WorldGeometry } from '../src/client/world/geometry.js';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frames: FrameRequestCallback[] = [];
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => frames.push(callback),
  });
  t.after(() => {
    if (original)
      Object.defineProperty(globalThis, 'requestAnimationFrame', original);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  });
  const root = {
    dataset: {} as DOMStringMap,
    style: { setProperty() {} },
  };
  const loads: number[] = [];
  const geometry = {
    width: 1000,
    height: 600,
    worldHeight: 4200,
    maxOffset: 3600,
    map: { style: { transform: '' } },
    load: (pumps: number) => loads.push(pumps),
  };
  const views: CameraView[] = [];
  const camera = new WorldCamera(
    root as unknown as HTMLElement,
    geometry as unknown as WorldGeometry,
    (view) => views.push(view),
  );
  const finishFrames = () => {
    while (frames.length) frames.shift()!(performance.now());
  };
  return { camera, root, geometry, views, loads, finishFrames };
}

test('a settlement resize preserves the animated final ascent to the new summit position', (t) => {
  const { camera, root, geometry, views, loads, finishFrames } = fixture(t);
  camera.move(24, true);
  finishFrames();
  const departure = Number(root.dataset.cameraOffset);
  camera.move(25, false);
  geometry.height = 598;
  geometry.worldHeight = 4186;
  geometry.maxOffset = 3588;
  camera.resize(25);
  assert.equal(root.dataset.instant, undefined);
  assert.equal(geometry.map.style.transform, 'translate3d(0, 3588px, 0)');
  assert.equal(views.at(-1)?.motionBottom, departure);
  assert.equal(views.at(-1)?.cameraOffset, geometry.maxOffset);
  assert.equal(loads.at(-1), 25);

  t.mock.timers.tick(FLIGHT_TIMING.pumpMs + 50);
  assert.equal(views.at(-1)?.motionBottom, geometry.maxOffset);
});

test('resizing after an ascent finishes aligns the camera immediately', (t) => {
  const { camera, root, geometry, views, finishFrames } = fixture(t);
  camera.move(24, true);
  finishFrames();
  camera.move(25, false);
  t.mock.timers.tick(FLIGHT_TIMING.pumpMs + 50);
  geometry.maxOffset = 3900;
  camera.resize(25);
  assert.equal(root.dataset.instant, 'true');
  assert.equal(views.at(-1)?.cameraOffset, 3900);
  assert.equal(views.at(-1)?.motionBottom, 3900);
  finishFrames();
  assert.equal(root.dataset.instant, undefined);
});

test('restoring a summit cancels pending camera motion before a later resize', (t) => {
  const { camera, root, geometry, views, finishFrames } = fixture(t);
  camera.move(24, false);
  camera.move(25, true);
  finishFrames();
  geometry.maxOffset = 4000;
  camera.resize(25);
  assert.equal(root.dataset.instant, 'true');
  assert.equal(views.at(-1)?.cameraOffset, 4000);
  const viewCount = views.length;
  t.mock.timers.tick(FLIGHT_TIMING.pumpMs + 50);
  assert.equal(views.length, viewCount);
});
