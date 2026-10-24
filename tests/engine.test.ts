import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getNextPopProbability,
  getPayoutCents,
  getPopPoint,
  getStep,
  LADDER,
  MAX_MULTIPLIER_MICROS,
  MAX_PUMPS,
  MULTIPLIER_SCALE,
  pumpRound,
  RANDOM_SPACE,
  validateBet,
} from '../src/engine/PumpEngine.js';

test('exact calculation: every cashout point has RTP at most 97%, including pump zero', () => {
  for (const step of LADDER) {
    const { survivalThreshold: threshold, multiplierMicros: multiplier } = step;
    // Survival probability is exactly threshold / 2^256, not a floating estimate.
    const target = 97n * RANDOM_SPACE * MULTIPLIER_SCALE;
    const actual = 100n * threshold * BigInt(multiplier);
    assert.ok(actual <= target, `Pump ${step.pumps} exceeds 97% RTP`);
    // The only difference is downward rounding of less than one multiplier micro.
    assert.ok(target - actual < 100n * threshold);

    for (const bet of [
      10, 11, 19, 99, 100, 101, 999, 10_000, 99_999, 100_000,
    ]) {
      const payout = BigInt(getPayoutCents(bet, step.pumps));
      assert.ok(100n * threshold * payout <= 97n * RANDOM_SPACE * BigInt(bet));
      const scaledPayout = BigInt(bet) * BigInt(multiplier);
      assert.ok(payout * MULTIPLIER_SCALE <= scaledPayout);
      assert.ok(scaledPayout < (payout + 1n) * MULTIPLIER_SCALE);
    }
  }
});

test('the curve grows risk and multiplier, and respects the game limits', () => {
  assert.equal(LADDER.length, 26);
  assert.equal(getStep(0).multiplierMicros, 970_000);
  assert.equal(getStep(25).multiplierMicros, 617_530_535);
  for (let pumps = 0; pumps < MAX_PUMPS; pumps++) {
    const risk = getNextPopProbability(pumps);
    assert.ok(risk !== null);
    assert.ok(Math.abs(risk - (0.04 + 0.015 * pumps)) < 1e-14);
    assert.ok(
      getStep(pumps + 1).multiplierMicros > getStep(pumps).multiplierMicros,
    );
    assert.ok(getStep(pumps + 1).multiplierMicros <= MAX_MULTIPLIER_MICROS);
  }
  assert.equal(getNextPopProbability(25), null);
});

test('every exact randomness boundary maps to the correct pop point', () => {
  assert.equal(getPopPoint(0n), 26);
  assert.equal(getPopPoint(RANDOM_SPACE - 1n), 1);
  for (let pumps = 1; pumps <= MAX_PUMPS; pumps++) {
    const threshold = getStep(pumps).survivalThreshold;
    assert.equal(getPopPoint(threshold), pumps);
    assert.ok(getPopPoint(threshold - 1n) > pumps);
  }
  assert.throws(() => getPopPoint(-1n), RangeError);
  assert.throws(() => getPopPoint(RANDOM_SPACE), RangeError);
});

test('pump outcomes are deterministic, pop correctly, and automatically settle at the top', () => {
  assert.deepEqual(pumpRound(0, 2), { pumps: 1, status: 'active' });
  assert.deepEqual(pumpRound(0, 2), pumpRound(0, 2));
  assert.deepEqual(pumpRound(1, 2), { pumps: 2, status: 'popped' });
  assert.deepEqual(pumpRound(24, 26), { pumps: 25, status: 'cashed_out' });
  assert.deepEqual(pumpRound(24, 25), { pumps: 25, status: 'popped' });
  assert.throws(() => pumpRound(25, 26), RangeError);
  assert.throws(() => pumpRound(1, 1), RangeError);
  assert.throws(() => pumpRound(0, 27), RangeError);
});

test('bets and ladder positions reject invalid inputs and payouts always round down', () => {
  for (const bet of [0, -10, 9, 100_001, 10.5, NaN, Infinity]) {
    assert.throws(() => validateBet(bet), RangeError);
  }
  for (const pumps of [-1, 0.5, 26, NaN])
    assert.throws(() => getStep(pumps), RangeError);
  validateBet(10);
  validateBet(100_000);
  assert.equal(getPayoutCents(10, 0), 9);
  assert.equal(getPayoutCents(100, 0), 97);
  assert.equal(getPayoutCents(100_000, 25), 61_753_053);
});
