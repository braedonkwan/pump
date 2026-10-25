import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServerSeed,
  deriveOutcome,
  sha256,
} from '../src/server/fairness.js';

test('fairness hashing matches known UTF-8 SHA-256 vectors', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const outcome = deriveOutcome(
    '00000000-0000-4000-8000-000000000000',
    '0'.repeat(64),
    1,
  );
  assert.equal(
    outcome.randomValueHex,
    '7e91ca7c0ea5780bff349df5467757c286ac9e0709b3e8115ce12efa76e496bf',
  );
  assert.equal(outcome.popAtPump, 8);
});

test('the cent-aligned curve uses its own reproducible seed domain', () => {
  const outcome = deriveOutcome(
    '00000000-0000-4000-8000-000000000000',
    '0'.repeat(64),
    2,
  );
  assert.equal(
    outcome.randomValueHex,
    '2e28394f9f0c67689d6004b846246755d1c0002db92b71be66cda76ebba86773',
  );
  assert.equal(outcome.popAtPump, 9);
});

test('the strictly increasing curve has its own reproducible seed domain', () => {
  const outcome = deriveOutcome(
    '00000000-0000-4000-8000-000000000000',
    '0'.repeat(64),
  );
  assert.equal(
    outcome.randomValueHex,
    '0fe05f1c25332c39be74b07e6ddb6937283db1b4ad4cf9892820eea987a9f387',
  );
  assert.equal(outcome.popAtPump, 13);
});

test('server seeds contain 32 cryptographically random bytes encoded as hex', () => {
  const first = createServerSeed();
  const second = createServerSeed();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});
