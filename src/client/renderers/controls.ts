import type { ActionState } from '../actions.js';
import { CENTS_PER_DOLLAR, MIN_BET_CENTS } from '../../shared/settings.js';
import { getMaximumBet } from '../bet-model.js';
import { element } from '../dom.js';
import { renderBetControls } from './bet.js';
const betInput = element<HTMLInputElement>('#bet');
const startButton = element<HTMLButtonElement>('#start-button');
const pumpButton = element<HTMLButtonElement>('#pump-button');
const cashoutButton = element<HTMLButtonElement>('#cashout-button');
export function renderControls(model: ActionState, settling: boolean): void {
  const { state, busy, connected, pendingAction } = model;
  const round = state?.round;
  const active = round?.status === 'active';
  const admitted = state?.room?.admitted !== false;
  const disabled = busy || !connected || settling;
  document.body.classList.toggle('has-active-round', active);
  const status = !connected
    ? busy
      ? 'connecting'
      : 'offline'
    : settling
      ? 'landing'
      : !admitted
        ? 'full'
        : active
          ? 'in-flight'
          : 'ready';
  element('#controls-status').dataset.state = status;
  element('#controls-status-label').textContent = status
    .replace('-', ' ')
    .toUpperCase();
  betInput.disabled = disabled || active || !admitted;
  if (active) betInput.value = (round.betCents / CENTS_PER_DOLLAR).toFixed(2);
  renderBetControls(state?.wallet.balanceCents ?? 0);
  startButton.disabled =
    disabled ||
    !admitted ||
    active ||
    getMaximumBet(state?.wallet.balanceCents ?? 0) < MIN_BET_CENTS;
  startButton.hidden = active;
  element('#round-actions').hidden = !active;
  pumpButton.disabled = disabled || !active || !admitted;
  cashoutButton.disabled = disabled || !active;
  element<HTMLButtonElement>('#fairness-button').disabled = !round;
  element('#reconnect-button').hidden = (connected && admitted) || busy;
  element('#reconnect-button').textContent =
    connected && !admitted ? 'Try again' : 'Reconnect';
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
