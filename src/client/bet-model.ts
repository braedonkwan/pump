import {
  BET_STEP_CENTS,
  MAX_BET_CENTS,
  MIN_BET_CENTS,
} from '../shared/settings.js';
import { money, parseAmountCents } from './format.js';

export const BET_ADJUSTMENTS = [
  'decrease',
  'increase',
  'min',
  'half',
  'double',
  'max',
] as const;
export type BetAdjustment = (typeof BET_ADJUSTMENTS)[number];

export function getMaximumBet(balanceCents: number): number {
  if (!Number.isSafeInteger(balanceCents) || balanceCents < MIN_BET_CENTS)
    return 0;
  return (
    Math.floor(Math.min(balanceCents, MAX_BET_CENTS) / BET_STEP_CENTS) *
    BET_STEP_CENTS
  );
}

export function adjustBet(
  cents: number | null,
  adjustment: BetAdjustment,
  balanceCents: number,
): number | null {
  const maximum = getMaximumBet(balanceCents);
  if (maximum < MIN_BET_CENTS) return null;
  const current =
    cents !== null && Number.isSafeInteger(cents) && cents >= 0
      ? cents
      : MIN_BET_CENTS;
  let next: number;
  switch (adjustment) {
    case 'decrease':
      next = (Math.ceil(current / BET_STEP_CENTS) - 1) * BET_STEP_CENTS;
      break;
    case 'increase':
      next = (Math.floor(current / BET_STEP_CENTS) + 1) * BET_STEP_CENTS;
      break;
    case 'min':
      next = MIN_BET_CENTS;
      break;
    case 'half':
      next = Math.floor(current / (2 * BET_STEP_CENTS)) * BET_STEP_CENTS;
      break;
    case 'double':
      next = current * 2;
      break;
    case 'max':
      next = maximum;
      break;
  }
  // Every shortcut produces a legal stake; manual entry remains explicit.
  return Math.max(
    MIN_BET_CENTS,
    Math.min(maximum, Math.floor(next / BET_STEP_CENTS) * BET_STEP_CENTS),
  );
}

export function getBetError(value: string, balanceCents: number): string {
  if (getMaximumBet(balanceCents) < MIN_BET_CENTS)
    return `Your balance is below the ${money(MIN_BET_CENTS)} minimum.`;
  const cents = parseAmountCents(value);
  if (cents === null) return 'Enter a valid bet amount.';
  if (cents < MIN_BET_CENTS) return `Minimum bet is ${money(MIN_BET_CENTS)}.`;
  if (cents > MAX_BET_CENTS) return `Maximum bet is ${money(MAX_BET_CENTS)}.`;
  if (cents % BET_STEP_CENTS !== 0)
    return `Use ${money(BET_STEP_CENTS)} increments.`;
  if (cents > balanceCents) return 'Your bet is higher than your balance.';
  return '';
}
