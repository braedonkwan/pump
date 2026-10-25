import type { ActionState } from '../actions.js';
import { CENTS_PER_DOLLAR } from '../../shared/settings.js';
import { element } from '../dom.js';
const betInput = element<HTMLInputElement>('#bet');
const startButton = element<HTMLButtonElement>('#start-button');
const pumpButton = element<HTMLButtonElement>('#pump-button');
const cashoutButton = element<HTMLButtonElement>('#cashout-button');
export function renderControls(model: ActionState, settling: boolean): void {
  const { state, busy, connected, pendingAction } = model;
  const round = state?.round;
  const active = round?.status === 'active';
  const disabled = busy || !connected || settling;
  document.body.classList.toggle('has-active-round', active);
  betInput.disabled = disabled || active;
  if (active) betInput.value = (round.betCents / CENTS_PER_DOLLAR).toFixed(2);
  startButton.disabled = disabled || active;
  startButton.hidden = active;
  element('#round-actions').hidden = !active;
  pumpButton.disabled = disabled || !active;
  cashoutButton.disabled = disabled || !active;
  element<HTMLButtonElement>('#fairness-button').disabled = !round;
  element('#reconnect-button').hidden = connected || busy;
  element('#start-label').textContent = settling
    ? 'Finishing flight…'
    : pendingAction === 'start'
      ? 'Taking off…'
      : round
        ? 'Start a new flight'
        : 'Start your ascent';
  element('#pump-label').textContent =
    pendingAction === 'pump' ? 'Catching air…' : 'Pump balloon';
  element('#cashout-button > span').textContent =
    pendingAction === 'cashout' ? 'Banking…' : 'Cash out';
}

export function setMessage(message: string): void {
  element('#message').textContent = message;
}
