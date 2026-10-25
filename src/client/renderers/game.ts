import { getNextPopProbability, getStep } from '../../engine/PumpEngine.js';
import {
  MAX_PUMPS,
  CURRENT_CURVE_VERSION,
  MULTIPLIER_SCALE,
  TARGET_RTP_PERCENT,
} from '../../shared/settings.js';
import type { GameState } from '../../shared/types.js';
import { element } from '../dom.js';
import { money, multiplier } from '../format.js';
import { getFlightEnding } from '../flight-model.js';
export function renderGame(state: GameState | null): void {
  const round = state?.round;
  const active = round?.status === 'active';
  const popped = round?.status === 'popped';
  const pumps = round?.pumps ?? 0;
  const poppingDisabled = round
    ? round.mode === 'testing'
    : (state?.poppingDisabled ?? false);
  const curveVersion = round?.curveVersion ?? CURRENT_CURVE_VERSION;
  element('#balance').textContent = state
    ? money(state.wallet.balanceCents)
    : '—';
  element('#pump-count').textContent = String(pumps).padStart(2, '0');
  element('#next-multiplier').textContent =
    `Next ${multiplier(getStep(Math.min(pumps + 1, MAX_PUMPS), curveVersion).multiplierMicros)}×`;

  const multiplierElement = element('#multiplier');
  const multiplierValue = popped
    ? '0.00'
    : multiplier(round?.multiplierMicros ?? Number(MULTIPLIER_SCALE));
  const times = document.createElement('span');
  times.textContent = '×';
  multiplierElement.replaceChildren(
    document.createTextNode(multiplierValue),
    times,
  );
  multiplierElement.style.setProperty(
    '--multiplier-length',
    String(multiplierValue.length + 1),
  );
  multiplierElement.title = `${multiplier(round?.multiplierMicros ?? Number(MULTIPLIER_SCALE), 6)}×`;
  element('#multiplier-label').textContent = popped
    ? 'UNTIL NEXT TIME'
    : active
      ? 'CURRENT MULTIPLIER'
      : round
        ? 'CASHED OUT AT'
        : 'READY FOR LIFTOFF';
  const payoutText = money(round?.cashoutCents ?? 0);
  const payoutElement = element('#payout');
  payoutElement.textContent = payoutText;
  payoutElement.style.setProperty('--amount-length', String(payoutText.length));
  element('#cashout-value').textContent = money(round?.cashoutCents ?? 0);
  element('#payout-label').textContent = active
    ? 'POTENTIAL PAYOUT'
    : popped
      ? 'ROUND PAYOUT'
      : round
        ? 'PAID TO YOUR WALLET'
        : 'POTENTIAL PAYOUT';
  element('#stake-caption').textContent = round
    ? `Stake ${money(round.betCents)}`
    : 'Your flight, your call.';
  const netReturn = round ? round.cashoutCents - round.betCents : null;
  const netElement = element('#net-return');
  netElement.textContent =
    netReturn === null
      ? ''
      : `${netReturn >= 0 ? '+' : '−'}${money(Math.abs(netReturn))} net`;
  netElement.classList.toggle(
    'is-negative',
    netReturn !== null && netReturn < 0,
  );
  const chance = round
    ? active
      ? round.nextPopProbability
      : null
    : poppingDisabled
      ? 0
      : getNextPopProbability(0);
  element('#rtp-label').textContent = poppingDisabled
    ? round
      ? '0% POP · TEST ROUND'
      : '0% POP · TEST MODE'
    : round && round.mode !== 'normal'
      ? 'MODE NOT RECORDED'
      : `${TARGET_RTP_PERCENT}% RTP`;
  const chanceText = chance === null ? '—' : `${(chance * 100).toFixed(2)}%`;
  element('#pop-chance').textContent = chanceText;
  element('#risk-caption').textContent =
    round && !active
      ? 'Round complete'
      : poppingDisabled
        ? 'Testing · popping disabled'
        : 'Chance of popping on your next pump.';
  // Use a true 0–100% scale rather than stretching the curve's maximum to 100%.
  element('#risk-fill').style.width = `${(chance ?? 0) * 100}%`;
  element('#risk-gauge').setAttribute(
    'aria-valuenow',
    ((chance ?? 0) * 100).toFixed(2),
  );
  element('#risk-gauge').setAttribute(
    'aria-valuetext',
    chance === null ? 'Round complete' : chanceText,
  );
  element('.risk-card').classList.toggle(
    'is-complete',
    Boolean(round && !active),
  );

  let status = 'Your next adventure starts here.';
  let hint = 'Every great flight starts on the ground.';
  if (active) {
    status =
      pumps === 0
        ? 'Ready when you are. Take your first pump.'
        : 'A new view. A bigger decision.';
    hint =
      pumps === 0
        ? 'Cash out now returns your full stake.'
        : 'A little higher, or call it a beautiful flight.';
  } else if (popped) {
    status = 'Some flights are shorter than others.';
    hint = 'A fresh balloon. A brand new possibility.';
  } else if (round) {
    status = 'Your payout is safely in your wallet.';
    hint =
      round.settlementReason === 'limit'
        ? `All ${MAX_PUMPS} pumps. Welcome to the Astral Crown.`
        : 'You chose your moment. Nicely done.';
  }
  element('#round-status').textContent = status;
  element('#scene-hint').textContent = hint;
  element('#flight-note').textContent = poppingDisabled
    ? active
      ? 'Testing round: popping is disabled for this flight.'
      : round
        ? 'This was a testing round. Its pop outcome was overridden.'
        : 'Testing mode: new flights have popping disabled.'
    : active
      ? 'Each pump increases risk. Cash out to collect your payout, including your stake.'
      : 'A new view with every pump. Cash out before the balloon pops to collect your payout.';

  element('#result-banner').hidden = !round || active;
  if (round && !active) {
    const ending = getFlightEnding(round);
    element('#result-banner').dataset.kind = ending ?? '';
    element('#result-label').textContent = popped
      ? 'FLIGHT ENDED'
      : round.settlementReason === 'limit'
        ? 'SUMMIT REACHED'
        : 'PAYOUT SECURED';
    element('#result-value').textContent = popped
      ? 'Balloon popped'
      : money(round.payoutCents);
    element('#result-caption').textContent = popped
      ? state?.wallet.refillCents
        ? `${money(round.betCents)} stake lost. Demo balance reset to ${money(state.wallet.refillCents)}.`
        : `${money(round.betCents)} stake lost. Start fresh whenever you’re ready.`
      : round.settlementReason === 'limit'
        ? 'The Astral Crown. You reached the very top.'
        : 'A beautiful place to call it.';
    element<SVGUseElement>('#result-icon use').setAttribute(
      'href',
      ending === 'pop'
        ? '#icon-burst'
        : ending === 'summit'
          ? '#icon-crown'
          : '#icon-check',
    );
    element('#result-pumps').textContent = `${pumps} / ${MAX_PUMPS}`;
    element('#result-multiplier-label').textContent = popped
      ? 'BEST MULTIPLIER'
      : 'LOCKED AT';
    element('#result-multiplier').textContent =
      `${multiplier(getStep(popped ? Math.max(0, pumps - 1) : pumps, curveVersion).multiplierMicros)}×`;
  }
}
