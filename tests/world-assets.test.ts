import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getBackdropSegments } from '../src/client/flight-model.js';

function readPng(path: string) {
  const bytes = readFileSync(
    new URL(`../src/client/public${path}`, import.meta.url),
  );
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return {
    bytes,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

test('the eight world textures exist, are distinct, and share their intended aspect ratio', () => {
  const hashes = new Set<string>();
  for (const scene of getBackdropSegments(3000)) {
    const image = readPng(scene.src);
    assert.equal(image.width / image.height, 1.5);
    hashes.add(createHash('sha256').update(image.bytes).digest('hex'));
  }
  assert.equal(hashes.size, 8);
});

test('the three eight-frame sprite atlases retain alpha and square frame geometry', () => {
  for (const atlas of [
    'butterfly-atlas',
    'sky-ray-atlas',
    'crown-whale-atlas',
  ]) {
    const image = readPng(`/art/sprites/${atlas}.png`);
    assert.equal(image.colorType, 6, `${atlas} must retain PNG transparency`);
    assert.equal(
      image.width % 4,
      0,
      `${atlas} columns must have whole-pixel widths`,
    );
    assert.equal(
      image.height % 2,
      0,
      `${atlas} rows must have whole-pixel heights`,
    );
    assert.equal(
      image.width / 4,
      image.height / 2,
      `${atlas} must have square frames`,
    );
  }
});

test('the final world has a portrait composition for phones', () => {
  const scenes = getBackdropSegments(3000);
  assert.equal(scenes.filter((scene) => scene.mobileSrc).length, 1);
  const final = scenes.at(-1)!;
  assert.equal(final.id, 'astral-crown');
  const portrait = readPng(final.mobileSrc!);
  assert.equal(portrait.width / portrait.height, 2 / 3);
});
