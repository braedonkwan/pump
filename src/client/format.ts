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

export function parseAmountCents(value: string): number | null {
  const amount = value.trim().replace(/^\$\s*/, '');
  const match =
    /^(?:(\d{1,7}|\d{1,3}(?:,\d{3}){1,2})(?:\.(\d{0,2}))?|\.(\d{1,2}))$/.exec(
      amount,
    );
  if (!match) return null;
  return (
    Number((match[1] ?? '0').replaceAll(',', '')) * CENTS_PER_DOLLAR +
    Number((match[2] ?? match[3] ?? '').padEnd(2, '0'))
  );
}

export function parseBet(value: string): number | null {
  const cents = parseAmountCents(value);
  return cents !== null &&
    cents >= MIN_BET_CENTS &&
    cents <= MAX_BET_CENTS &&
    cents % BET_STEP_CENTS === 0
    ? cents
    : null;
}
