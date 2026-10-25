import {
  MIN_BET_CENTS,
  MAX_BET_CENTS,
  BET_STEP_CENTS,
} from '../shared/settings.js';
import type { GameActions } from './actions.js';
import { element } from './dom.js';
import { money, parseBet } from './format.js';
import { setMessage } from './renderers/controls.js';
import type { GameDialogs } from './renderers/dialogs.js';

export function wireEvents(actions: GameActions, dialogs: GameDialogs): void {
  const bet = element<HTMLInputElement>('#bet');
  element<HTMLFormElement>('#bet-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (bet.disabled) return;
    const betCents = parseBet(bet.value);
    if (betCents === null) {
      setMessage(
        `Enter a bet from ${money(MIN_BET_CENTS)} to ${money(MAX_BET_CENTS)} in ${money(BET_STEP_CENTS)} increments.`,
      );
      bet.focus();
      return;
    }
    if (actions.state && betCents > actions.state.wallet.balanceCents) {
      setMessage('Your bet is higher than your balance.');
      return;
    }
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
