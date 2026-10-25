import {
  CENTS_PER_DOLLAR,
  MIN_BET_CENTS,
  MAX_BET_CENTS,
  BET_STEP_CENTS,
  MULTIPLIER_SCALE,
} from '../shared/settings.js';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function money(cents: number): string {
  return currency.format(cents / CENTS_PER_DOLLAR);
}

export function multiplier(micros: number, precision = 2): string {
  return (micros / Number(MULTIPLIER_SCALE)).toFixed(precision);
}

export function parseBet(value: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match?.[1]) return null;
  const cents =
    Number(match[1]) * CENTS_PER_DOLLAR +
    Number((match[2] ?? '').padEnd(2, '0'));
  return cents >= MIN_BET_CENTS &&
    cents <= MAX_BET_CENTS &&
    cents % BET_STEP_CENTS === 0
    ? cents
    : null;
}
