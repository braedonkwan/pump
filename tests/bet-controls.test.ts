import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adjustBet,
  BET_ADJUSTMENTS,
  getBetError,
  getMaximumBet,
} from '../src/client/bet-model.js';
import { parseAmountCents, parseBet } from '../src/client/format.js';

test('bet editing accepts decimal and pasted currency without floating-point arithmetic', () => {
  for (const [value, cents] of [
    ['.10', 10],
    ['.5', 50],
    ['10.', 1000],
    ['$1,000.00', 100_000],
    [' $ 12.30 ', 1230],
  ] as const) {
    assert.equal(parseAmountCents(value), cents);
    assert.equal(parseBet(value), cents);
  }
  assert.equal(parseAmountCents('0.13'), 13);
  assert.equal(
    parseBet('0.13'),
    null,
    'Manual entry never silently rounds a bet',
  );
  for (const value of [
    '1,00',
    '1,000,00',
    '1..00',
    '.',
    '$',
    '-1',
    '1e2',
    '1.005',
  ]) {
    assert.equal(parseAmountCents(value), null, value);
  }
});

test('maximum bet respects the balance, game limit, and ten-cent step', () => {
  assert.equal(getMaximumBet(1_000_000), 100_000);
  assert.equal(getMaximumBet(237), 230);
  assert.equal(getMaximumBet(19), 10);
  assert.equal(getMaximumBet(10), 10);
  assert.equal(getMaximumBet(9), 0);
  assert.equal(getMaximumBet(0), 0);
});

test('half and double round to legal stakes and clamp to affordable limits', () => {
  assert.equal(adjustBet(130, 'half', 10_000), 60);
  assert.equal(adjustBet(30, 'half', 10_000), 10);
  assert.equal(adjustBet(10, 'half', 10_000), 10);
  assert.equal(adjustBet(130, 'double', 10_000), 260);
  assert.equal(adjustBet(130, 'double', 237), 230);
  assert.equal(adjustBet(60_000, 'double', 1_000_000), 100_000);
  assert.equal(adjustBet(1000, 'min', 1_000_000), 10);
  assert.equal(adjustBet(1000, 'max', 237), 230);
});

test('step controls move in the requested direction from an off-step typed amount', () => {
  assert.equal(adjustBet(101, 'increase', 10_000), 110);
  assert.equal(adjustBet(101, 'decrease', 10_000), 100);
  assert.equal(adjustBet(110, 'increase', 10_000), 120);
  assert.equal(adjustBet(110, 'decrease', 10_000), 100);
  assert.equal(adjustBet(null, 'min', 10_000), 10);
  assert.equal(adjustBet(null, 'increase', 10_000), 20);
  assert.equal(adjustBet(10, 'decrease', 10_000), 10);
});

test('shortcuts never produce unaffordable, fractional, or below-minimum stakes', () => {
  for (const balance of [0, 9, 10, 19, 237, 100_000, 1_000_000]) {
    for (const current of [
      null,
      0,
      9,
      10,
      11,
      130,
      1000,
      99_990,
      100_000,
      100_001,
    ]) {
      for (const adjustment of BET_ADJUSTMENTS) {
        const next = adjustBet(current, adjustment, balance);
        if (balance < 10) {
          assert.equal(next, null);
        } else {
          assert.ok(
            next !== null && next >= 10 && next <= Math.min(balance, 100_000),
          );
          assert.equal(next % 10, 0);
          assert.ok(Number.isSafeInteger(next));
        }
      }
    }
  }
});

test('manual-entry feedback distinguishes rounding, balance, and amount limits', () => {
  assert.match(getBetError('0.13', 1000), /\$0\.10 increments/);
  assert.match(getBetError('2.40', 237), /higher than your balance/);
  assert.match(getBetError('0.09', 1000), /Minimum bet/);
  assert.match(getBetError('1000.10', 1_000_000), /Maximum bet/);
  assert.match(getBetError('0.10', 9), /balance is below/);
  assert.match(getBetError('', 1000), /valid bet amount/);
  assert.equal(getBetError('2.30', 237), '');
});
