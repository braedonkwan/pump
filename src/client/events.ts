import { CENTS_PER_DOLLAR } from '../shared/settings.js';
import type { GameActions } from './actions.js';
import {
  BET_ADJUSTMENTS,
  adjustBet,
  getBetError,
  type BetAdjustment,
} from './bet-model.js';
import { element } from './dom.js';
import { parseAmountCents, parseBet } from './format.js';
import { renderBetControls } from './renderers/bet.js';
import { setMessage } from './renderers/controls.js';
import type { GameDialogs } from './renderers/dialogs.js';

export function wireEvents(actions: GameActions, dialogs: GameDialogs): void {
  const bet = element<HTMLInputElement>('#bet');
  const balance = () => actions.state?.wallet.balanceCents ?? 0;
  const updateBet = (cents: number | null) => {
    if (bet.disabled || cents === null) return;
    bet.value = (cents / CENTS_PER_DOLLAR).toFixed(2);
    setMessage('');
    renderBetControls(balance());
  };
  const adjust = (adjustment: BetAdjustment) =>
    updateBet(adjustBet(parseAmountCents(bet.value), adjustment, balance()));
  for (const adjustment of BET_ADJUSTMENTS) {
    element(`[data-bet-adjust="${adjustment}"]`).addEventListener('click', () =>
      adjust(adjustment),
    );
  }
  document
    .querySelectorAll<HTMLButtonElement>('[data-bet-preset]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        if (!button.disabled) updateBet(Number(button.dataset.betPreset));
      });
    });
  bet.addEventListener('input', () => {
    setMessage('');
    renderBetControls(balance());
  });
  bet.addEventListener('blur', () => {
    const cents = parseBet(bet.value);
    if (cents !== null) updateBet(cents);
  });
  bet.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    adjust(event.key === 'ArrowUp' ? 'increase' : 'decrease');
  });
  element<HTMLFormElement>('#bet-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (bet.disabled) return;
    const betCents = parseBet(bet.value);
    if (betCents === null || getBetError(bet.value, balance())) {
      renderBetControls(balance());
      bet.focus();
      return;
    }
    updateBet(betCents);
    void actions.start(betCents);
  });
  element('#pump-button').addEventListener(
    'click',
    () => void actions.play('pump'),
  );
  element('#cashout-button').addEventListener(
    'click',
    () => void actions.play('cashout'),
  );
  element('#reconnect-button').addEventListener(
    'click',
    () => void actions.connect(),
  );
  element('#fairness-button').addEventListener('click', () => {
    if (actions.state?.round) dialogs.showProof(actions.state.round);
  });
  element('#how-to-button').addEventListener('click', () =>
    dialogs.howTo.showModal(),
  );
  for (const dialog of [dialogs.howTo, dialogs.proof]) {
    dialog
      .querySelectorAll<HTMLButtonElement>('[data-close-dialog]')
      .forEach((button) => {
        button.addEventListener('click', () => dialog.close());
      });
    dialog.addEventListener('click', (event) => {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.target === dialog &&
        (event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom)
      )
        dialog.close();
    });
  }
}
