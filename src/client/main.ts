import './styles.css';
import {
  getNextPopProbability,
  getStep,
  MAX_BET_CENTS,
  MAX_PUMPS,
  MIN_BET_CENTS,
} from '../engine/PumpEngine.js';
import type { GameState, RoundView } from '../shared/types.js';
import { FlightWorld } from './world.js';

function element<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

const betInput = element<HTMLInputElement>('#bet');
const betForm = element<HTMLFormElement>('#bet-form');
const startButton = element<HTMLButtonElement>('#start-button');
const pumpButton = element<HTMLButtonElement>('#pump-button');
const cashoutButton = element<HTMLButtonElement>('#cashout-button');
const proofDialog = element<HTMLDialogElement>('#proof-dialog');
const howToDialog = element<HTMLDialogElement>('#how-to-dialog');
const world = new FlightWorld(element('#world-scene'));
const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});
let state: GameState | null = null;
let busy = false;
let connected = false;
let restoringWorld = true;
let pendingAction: string | null = null;
let selectedProof: RoundView | null = null;

function money(cents: number): string {
  return currency.format(cents / 100);
}
function multiplier(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

function readBet(): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(betInput.value.trim());
  if (!match?.[1]) return null;
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents >= MIN_BET_CENTS && cents <= MAX_BET_CENTS ? cents : null;
}

async function api(path: string, body?: object): Promise<GameState> {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof value === 'object' && value !== null && 'error' in value
        ? String(value.error)
        : 'Could not complete that request.';
    throw new Error(message);
  }
  return value as GameState;
}

function setMessage(message: string): void {
  element('#message').textContent = message;
}

function render(): void {
  const round = state?.round;
  const active = round?.status === 'active';
  const popped = round?.status === 'popped';
  const pumps = round?.pumps ?? 0;
  const poppingDisabled = state?.poppingDisabled ?? false;
  const disabled = busy || !connected;
  element('#balance').textContent = state
    ? money(state.wallet.balanceCents)
    : '—';
  document.body.classList.toggle('has-active-round', active);
  betInput.disabled = disabled || active;
  if (active) betInput.value = (round.betCents / 100).toFixed(2);
  startButton.disabled = disabled || active;
  startButton.hidden = active;
  element('#round-actions').hidden = !active;
  pumpButton.disabled = disabled || !active;
  cashoutButton.disabled = disabled || !active;
  element<HTMLButtonElement>('#fairness-button').disabled = !round;
  element('#reconnect-button').hidden = connected || busy;
  element('#start-label').textContent =
    pendingAction === 'start'
      ? 'Taking off…'
      : round
        ? 'Start a new flight'
        : 'Start your ascent';
  element('#pump-label').textContent =
    pendingAction === 'pump' ? 'Catching air…' : 'Pump balloon';
  element('#cashout-button > span').textContent =
    pendingAction === 'cashout' ? 'Banking…' : 'Cash out';
  element('#pump-count').textContent = String(pumps).padStart(2, '0');
  element('#next-multiplier').textContent =
    `Next ${multiplier(getStep(Math.min(pumps + 1, MAX_PUMPS)).multiplierMicros)}×`;

  const multiplierElement = element('#multiplier');
  const multiplierValue = popped
    ? '0.00'
    : multiplier(round?.multiplierMicros ?? 1_000_000);
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
  multiplierElement.title = `${((round?.multiplierMicros ?? 1_000_000) / 1_000_000).toFixed(6)}×`;
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
  const chance = poppingDisabled
    ? 0
    : active
      ? round.nextPopProbability
      : getNextPopProbability(0);
  element('#rtp-label').textContent = poppingDisabled
    ? '0% POP · TEST MODE'
    : '97% RTP';
  element('#pop-chance').textContent = `${((chance ?? 0) * 100).toFixed(1)}%`;
  element('#risk-fill').style.width =
    `${Math.min(100, ((chance ?? 0) / 0.4) * 100)}%`;

  let status = 'Your next adventure starts here.';
  let hint = 'Every great flight starts on the ground.';
  if (active) {
    status =
      pumps === 0
        ? 'Ready when you are. Take your first pump.'
        : 'A new view. A bigger decision.';
    hint =
      pumps === 0
        ? 'Cash out now returns 0.97× your bet.'
        : 'A little higher, or call it a beautiful flight.';
  } else if (popped) {
    status = 'Some flights are shorter than others.';
    hint = 'A fresh balloon. A brand new possibility.';
  } else if (round) {
    status = 'Your payout is safely in your wallet.';
    hint =
      round.settlementReason === 'limit'
        ? 'All 25 pumps. Welcome to the Astral Crown.'
        : 'You chose your moment. Nicely done.';
  }
  element('#round-status').textContent = status;
  element('#scene-hint').textContent = hint;
  element('#flight-note').textContent = poppingDisabled
    ? 'Popping is disabled for testing. Explore all 25 pumps or cash out whenever you like.'
    : active
      ? 'Every pump lifts you higher and raises the pop chance. The cash-out amount includes your stake.'
      : 'A new view with every pump. Cash out before the balloon pops to keep your payout.';

  element('#result-banner').hidden = !round || active;
  if (round && !active) {
    element('#result-label').textContent = popped
      ? 'FLIGHT ENDED'
      : round.settlementReason === 'limit'
        ? 'SUMMIT REACHED'
        : 'PAYOUT SECURED';
    element('#result-value').textContent = popped
      ? 'Balloon popped'
      : money(round.payoutCents);
    element('#result-caption').textContent = popped
      ? `${money(round.betCents)} stake lost. Start fresh whenever you’re ready.`
      : round.settlementReason === 'limit'
        ? 'The Astral Crown. You reached the very top.'
        : 'A beautiful place to call it.';
    element<SVGUseElement>('#result-icon use').setAttribute(
      'href',
      popped ? '#icon-wind' : '#icon-check',
    );
  }
  if (proofDialog.open && selectedProof?.id === round?.id && round)
    fillProof(round);
  renderHistory();
  world.update(round ?? null, restoringWorld);
  if (state) restoringWorld = false;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

function renderHistory(): void {
  const body = element<HTMLTableSectionElement>('#history-body');
  body.replaceChildren();
  if (!state?.history.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 6;
    cell.className = 'empty-history';
    const label = document.createElement('span');
    label.textContent = 'Your first flight is waiting.';
    const detail = document.createElement('small');
    detail.textContent = 'Start a round to leave the ground.';
    cell.append(icon('wind'), label, detail);
    return;
  }
  for (const round of state.history) {
    const row = body.insertRow();
    const button = document.createElement('button');
    button.className = 'round-id-button';
    button.textContent = `#${round.id.slice(0, 6).toUpperCase()}`;
    button.setAttribute(
      'aria-label',
      `View seed details for round ${round.id}`,
    );
    button.addEventListener('click', () => showProof(round));
    row.insertCell().append(button);
    const badge = document.createElement('span');
    badge.className =
      round.status === 'popped' ? 'outcome-badge is-popped' : 'outcome-badge';
    badge.append(
      icon(round.status === 'popped' ? 'wind' : 'check'),
      document.createTextNode(
        round.status === 'popped' ? 'Popped' : 'Cashed out',
      ),
    );
    row.insertCell().append(badge);
    row.insertCell().textContent = `${round.pumps} / 25`;
    row.insertCell().textContent = money(round.betCents);
    row.insertCell().textContent = `${round.status === 'popped' ? '0.00' : multiplier(round.multiplierMicros)}×`;
    const payout = row.insertCell();
    payout.textContent = money(round.payoutCents);
    if (round.status === 'cashed_out') payout.className = 'history-payout';
  }
}

async function loadState(): Promise<void> {
  state = await api('/pump/state');
  connected = true;
}

async function act(path: string, body: object): Promise<void> {
  if (busy || !connected) return;
  busy = true;
  pendingAction = path.split('/').at(-1) ?? null;
  setMessage('');
  render();
  try {
    state = await api(path, body);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Could not complete that request.';
    // A lost response can still have committed. Restore before allowing another move.
    try {
      await loadState();
      setMessage(message);
    } catch {
      connected = false;
      setMessage('Connection interrupted. Reconnect to restore your flight.');
    }
  } finally {
    busy = false;
    pendingAction = null;
    render();
  }
}

function play(action: 'pump' | 'cashout'): void {
  const round = state?.round;
  if (round?.status !== 'active') return;
  void act(`/pump/${action}`, {
    roundId: round.id,
    expectedVersion: round.version,
  });
}

betForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const betCents = readBet();
  if (betCents === null) {
    setMessage(
      'Enter a bet from $0.10 to $1,000.00, with up to two decimal places.',
    );
    betInput.focus();
    return;
  }
  if (state && betCents > state.wallet.balanceCents) {
    setMessage('Your bet is higher than your balance.');
    return;
  }
  void act('/pump/start', { betCents, requestId: crypto.randomUUID() });
});
pumpButton.addEventListener('click', () => play('pump'));
cashoutButton.addEventListener('click', () => play('cashout'));

function fillProof(round: RoundView): void {
  selectedProof = round;
  element('#proof-description').textContent = state?.poppingDisabled
    ? 'Testing mode bypasses pop outcomes. The seed and pop point below describe the normal outcome, before the testing override.'
    : 'Your balloon’s outcome is fixed before its first pump. The seed is revealed when the round ends.';
  element('#proof-round-id').textContent = round.id;
  element('#seed-hash').textContent = round.serverSeedHash;
  element('#server-seed').textContent =
    round.proof?.serverSeed ?? 'Revealed when this flight ends.';
  element('#proof-pop-point').textContent = !round.proof
    ? 'Hidden while your flight is active.'
    : round.proof.popAtPump > MAX_PUMPS
      ? 'Survives all 25 pumps.'
      : `Pump ${round.proof.popAtPump}`;
}

function showProof(round: RoundView): void {
  fillProof(round);
  proofDialog.showModal();
}
element('#fairness-button').addEventListener('click', () => {
  if (state?.round) showProof(state.round);
});
element('#how-to-button').addEventListener('click', () =>
  howToDialog.showModal(),
);
for (const dialog of [howToDialog, proofDialog]) {
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

async function connect(): Promise<void> {
  if (busy) return;
  busy = true;
  setMessage('Connecting to your wallet…');
  render();
  try {
    await loadState();
    setMessage('');
  } catch {
    connected = false;
    setMessage('Could not reach the game. Reconnect to try again.');
  } finally {
    busy = false;
    render();
  }
}
element('#reconnect-button').addEventListener('click', () => {
  void connect();
});
void connect();
