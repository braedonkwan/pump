import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKDROP_OVERLAP,
  FLIGHT_ZONES,
  getBackdropSegments,
  getFlightZone,
  getWorldLayout,
  getWorldAtmosphere,
} from '../src/client/flight-model.js';

test('the flight starts at the very bottom and reaches the exact top on pump 25', () => {
  for (const [width, height] of [
    [950, 630],
    [350, 500],
    [1200, 700],
  ]) {
    const start = getWorldLayout(width!, height!, 0);
    const finish = getWorldLayout(width!, height!, 25);
    assert.equal(start.offset, 0);
    assert.equal(finish.offset, finish.worldHeight - height!);
    assert.equal(finish.progress, 1);
    assert.ok(finish.worldHeight >= height! * (FLIGHT_ZONES.length - 1));
  }
});

test('each confirmed pump moves the camera upward by one of 25 equal steps', () => {
  let previous = 0;
  const travel = getWorldLayout(900, 600, 25).maxOffset;
  for (let pumps = 1; pumps <= 25; pumps++) {
    const frame = getWorldLayout(900, 600, pumps);
    assert.ok(frame.offset > previous);
    assert.ok(Math.abs(frame.offset - previous - travel / 25) < 1e-9);
    previous = frame.offset;
  }
});

test('restoring a round or resizing derives the same relative position from its pump count', () => {
  const desktop = getWorldLayout(1000, 620, 17);
  const mobile = getWorldLayout(360, 500, 17);
  assert.equal(desktop.progress, 17 / 25);
  assert.equal(mobile.progress, desktop.progress);
  assert.deepEqual(getWorldLayout(1000, 620, 17), desktop);
  assert.ok(
    Math.abs(mobile.offset / mobile.maxOffset - desktop.progress) < 1e-12,
  );
});

test('eight distinct milestones reserve the Astral Crown for pump 25', () => {
  assert.equal(getFlightZone(0).name, 'The meadow');
  assert.equal(FLIGHT_ZONES.length, 8);
  assert.equal(getFlightZone(3).index, 0);
  assert.equal(getFlightZone(4).name, 'Cloudlands');
  assert.equal(getFlightZone(5).name, 'Cloudlands');
  assert.equal(getFlightZone(8).name, 'Crystal expanse');
  assert.equal(getFlightZone(12).name, 'The tempest sea');
  assert.equal(getFlightZone(16).name, 'Aurora gardens');
  assert.equal(getFlightZone(20).name, 'Celestial ruins');
  assert.equal(getFlightZone(24).name, 'The stargate');
  assert.equal(getFlightZone(25).name, 'The Astral Crown');
});

test('invalid camera dimensions and pump counts fail explicitly', () => {
  for (const pumps of [-1, 26, 1.5, NaN]) {
    assert.throws(() => getWorldLayout(900, 600, pumps), RangeError);
    assert.throws(() => getFlightZone(pumps), RangeError);
  }
  for (const dimension of [0, -1, Infinity, NaN]) {
    assert.throws(() => getWorldLayout(dimension, 600, 0), RangeError);
    assert.throws(() => getWorldLayout(900, dimension, 0), RangeError);
  }
});

test('eight distinct backdrop scenes cover the entire world without gaps', () => {
  for (const totalHeight of [2500, 3200, 4750]) {
    const scenes = getBackdropSegments(totalHeight);
    assert.equal(scenes.length, 8);
    assert.equal(new Set(scenes.map((scene) => scene.src)).size, 8);
    assert.equal(scenes[0]?.bottom, 0);
    assert.equal(scenes[0]?.id, 'meadow');
    const last = scenes.at(-1)!;
    assert.equal(last.id, 'astral-crown');
    assert.ok(Math.abs(last.bottom + last.height - totalHeight) < 1e-9);
    for (let index = 1; index < scenes.length; index++) {
      const below = scenes[index - 1]!;
      const above = scenes[index]!;
      const overlap = below.bottom + below.height - above.bottom;
      assert.ok(Math.abs(overlap / above.height - BACKDROP_OVERLAP) < 1e-12);
    }
  }
});

test('every camera slice stays covered while passing between backdrop scenes', () => {
  const viewport = 630;
  for (let pumps = 0; pumps <= 25; pumps++) {
    const layout = getWorldLayout(950, viewport, pumps);
    const scenes = getBackdropSegments(layout.worldHeight);
    for (let y = layout.offset; y <= layout.offset + viewport; y += 7) {
      assert.ok(
        scenes.some(
          (scene) =>
            y >= scene.bottom - 1e-9 && y <= scene.bottom + scene.height + 1e-9,
        ),
        `Uncovered world position ${y} at pump ${pumps}`,
      );
    }
  }
});

test('invalid scene heights fail before generating backdrop positions', () => {
  for (const height of [0, -1, NaN, Infinity]) {
    assert.throws(() => getBackdropSegments(height), RangeError);
  }
});

test('atmosphere grows richer on every pump and summit light appears only near the top', () => {
  let previous = 0;
  for (let pump = 0; pump <= 25; pump++) {
    const atmosphere = getWorldAtmosphere(pump);
    assert.ok(atmosphere.wonder > previous);
    assert.ok(atmosphere.wonder <= 1);
    assert.ok(atmosphere.crownGlow >= 0 && atmosphere.crownGlow <= 1);
    if (pump <= 21) assert.equal(atmosphere.crownGlow, 0);
    previous = atmosphere.wonder;
  }
  assert.equal(getWorldAtmosphere(25).wonder, 1);
  assert.equal(getWorldAtmosphere(25).crownGlow, 1);
  for (const pump of [-1, 26, 1.5, NaN])
    assert.throws(() => getWorldAtmosphere(pump), RangeError);
});
