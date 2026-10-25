import {
  BET_STEP_CENTS,
  CENTS_PER_DOLLAR,
  MAX_BET_CENTS,
  MIN_BET_CENTS,
} from '../../shared/settings.js';
import {
  BET_ADJUSTMENTS,
  adjustBet,
  getBetError,
  getMaximumBet,
} from '../bet-model.js';
import { element } from '../dom.js';
import { money, parseAmountCents } from '../format.js';

const input = element<HTMLInputElement>('#bet');
const adjustmentButtons = BET_ADJUSTMENTS.map((adjustment) => ({
  adjustment,
  button: element<HTMLButtonElement>(`[data-bet-adjust="${adjustment}"]`),
}));
const presets = [
  ...document.querySelectorAll<HTMLButtonElement>('[data-bet-preset]'),
];

export function renderBetControls(balanceCents: number): void {
  const current = parseAmountCents(input.value);
  const maximum = getMaximumBet(balanceCents);
  for (const { adjustment, button } of adjustmentButtons) {
    const next = adjustBet(current, adjustment, balanceCents);
    button.disabled = input.disabled || next === null || next === current;
    if (next !== null)
      button.title = `${button.getAttribute('aria-label')}: ${money(next)}`;
  }
  for (const button of presets) {
    const cents = Number(button.dataset.betPreset);
    button.disabled = input.disabled || cents > maximum;
    button.setAttribute('aria-pressed', String(current === cents));
  }
  element('#bet-balance').textContent = `Available ${money(balanceCents)}`;
  const error = input.disabled ? '' : getBetError(input.value, balanceCents);
  input.setAttribute('aria-invalid', String(Boolean(error)));
  input.setAttribute(
    'aria-valuemin',
    (MIN_BET_CENTS / CENTS_PER_DOLLAR).toFixed(2),
  );
  input.setAttribute(
    'aria-valuemax',
    (
      (input.disabled ? MAX_BET_CENTS : Math.max(maximum, MIN_BET_CENTS)) /
      CENTS_PER_DOLLAR
    ).toFixed(2),
  );
  if (current === null) {
    input.removeAttribute('aria-valuenow');
    input.removeAttribute('aria-valuetext');
  } else {
    input.setAttribute(
      'aria-valuenow',
      (current / CENTS_PER_DOLLAR).toFixed(2),
    );
    input.setAttribute('aria-valuetext', money(current));
  }
  input.title = `Use the up and down arrow keys to adjust by ${money(BET_STEP_CENTS)}.`;
  element('#bet-error').textContent = error;
  element('#bet-error').hidden = !error;
  element('.bet-field').classList.toggle('has-error', Boolean(error));
}
