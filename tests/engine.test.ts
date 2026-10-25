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

test('every allowed bet and cashout has exact RTP between 96.99% and 97%', () => {
  for (const step of LADDER.slice(1)) {
    // P(survive) = threshold / 2^256. Cross-multiply to avoid floating-point estimates.
    for (let bet = 10; bet <= 100_000; bet += 10) {
      const payout = BigInt(getPayoutCents(bet, step.pumps));
      const expectedReturnNumerator = step.survivalThreshold * payout;
      const totalBetNumerator = RANDOM_SPACE * BigInt(bet);
      assert.ok(100n * expectedReturnNumerator <= 97n * totalBetNumerator);
      assert.ok(
        10_000n * expectedReturnNumerator >= 9_699n * totalBetNumerator,
      );
      // Ten-cent stakes and this ladder pay whole cents without extra payout rounding.
      assert.equal(
        (BigInt(bet) * BigInt(step.multiplierMicros)) % MULTIPLIER_SCALE,
        0n,
      );
    }
  }
  assert.equal(getPayoutCents(10, 1), 11);
  assert.equal(getPayoutCents(10, 25), 10_000);
});

test('zero-pump cashout refunds the entire stake under current and archived rules', () => {
  assert.equal(getStep(0).multiplierMicros, 1_000_000);
  for (const bet of [10, 20, 100, 1000, 100_000])
    assert.equal(getPayoutCents(bet, 0), bet);
  for (const curveVersion of [1, 2] as const) {
    for (const bet of [10, 11, 19, 99, 100, 101, 1000, 99_999, 100_000]) {
      assert.equal(getPayoutCents(bet, 0, curveVersion), bet);
    }
  }
});

test('pop risk strictly increases on every pump, including the displayed percentage', () => {
  let previousRisk = 0;
  let previousDisplay = 0;
  for (let pump = 1; pump <= MAX_PUMPS; pump++) {
    const risk = getNextPopProbability(pump - 1)!;
    assert.ok(risk > previousRisk, 'Risk must rise at pump ' + pump);
    const display = Number((risk * 100).toFixed(2));
    assert.ok(
      display > previousDisplay,
      'Displayed risk must rise at pump ' + pump,
    );
    if (pump > 1) {
      const a = getStep(pump - 2).survivalThreshold;
      const b = getStep(pump - 1).survivalThreshold;
      const c = getStep(pump).survivalThreshold;
      // c/b < b/a proves that the conditional pop probability strictly increases.
      assert.ok(c * a < b * b);
    }
    previousRisk = risk;
    previousDisplay = display;
  }
  assert.equal(getNextPopProbability(MAX_PUMPS), null);
});

test('all 25 pumps increase the payout and the summit reaches exactly the 1000x cap', () => {
  assert.equal(LADDER.length, MAX_PUMPS + 1);
  assert.equal(getStep(0).multiplierMicros, 1_000_000);
  assert.equal(getStep(25).multiplierMicros, 1_000_000_000);
  for (let pump = 1; pump <= MAX_PUMPS; pump++) {
    assert.ok(
      getStep(pump).multiplierMicros > getStep(pump - 1).multiplierMicros,
    );
    assert.ok(getStep(pump).multiplierMicros <= MAX_MULTIPLIER_MICROS);
    assert.deepEqual(pumpRound(pump - 1, MAX_PUMPS + 1), {
      pumps: pump,
      status: pump === MAX_PUMPS ? 'cashed_out' : 'active',
    });
  }
});

test('curve two retains its original payouts, odd-cent support, and thresholds', () => {
  const payouts = [
    10, 11, 13, 16, 20, 25, 32, 41, 53, 69, 90, 118, 155, 204, 269, 355, 469,
    620, 820, 1085, 1436, 1901, 2535, 3426, 4694, 6520,
  ];
  for (let pump = 0; pump <= MAX_PUMPS; pump++) {
    assert.equal(getPayoutCents(10, pump, 2), payouts[pump]);
    if (pump > 0) {
      assert.equal(
        getStep(pump, 2).survivalThreshold,
        (97n * RANDOM_SPACE * 10n) / (100n * BigInt(payouts[pump]!)),
      );
    }
  }
  assert.equal(getPayoutCents(13, 2, 2), 16);
});

test('existing rounds keep their original curve and pop points', () => {
  assert.equal(getStep(25, 1).multiplierMicros, 617_530_535);
  for (let pumps = 0; pumps < MAX_PUMPS; pumps++) {
    assert.ok(
      Math.abs(getNextPopProbability(pumps, 1)! - (0.04 + 0.015 * pumps)) <
        1e-14,
    );
    const threshold = getStep(pumps + 1, 1).survivalThreshold;
    assert.equal(getPopPoint(threshold, 1), pumps + 1);
    assert.ok(getPopPoint(threshold - 1n, 1) > pumps + 1);
  }
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
  for (const bet of [
    0,
    -10,
    9,
    11,
    13,
    99,
    101,
    99_999,
    100_001,
    10.5,
    NaN,
    Infinity,
  ]) {
    assert.throws(() => validateBet(bet), RangeError);
  }
  for (const pumps of [-1, 0.5, 26, NaN])
    assert.throws(() => getStep(pumps), RangeError);
  validateBet(10);
  validateBet(100_000);
  assert.equal(getPayoutCents(10, 0), 10);
  assert.equal(getPayoutCents(100, 0), 100);
  assert.equal(getPayoutCents(100_000, 25), 100_000_000);
});
