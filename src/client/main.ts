import './styles.css';
import {
  getNextPopProbability,
  MAX_BET_CENTS,
  MIN_BET_CENTS,
} from '../engine/PumpEngine.js';
import type { GameState } from '../shared/types.js';

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

const betInput = element<HTMLInputElement>('#bet');
const betForm = element<HTMLFormElement>('#bet-form');
const startButton = element<HTMLButtonElement>('#start-button');
const pumpButton = element<HTMLButtonElement>('#pump-button');
const cashoutButton = element<HTMLButtonElement>('#cashout-button');
const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});
let state: GameState | null = null;
let busy = false;
let connected = false;

function money(cents: number): string {
  return currency.format(cents / 100);
}

function multiplier(micros: number): string {
  return `${(micros / 1_000_000).toFixed(2)}x`;
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
  const disabled = busy || !connected;

  element('#balance').textContent = state
    ? money(state.wallet.balanceCents)
    : 'Loading...';
  betInput.disabled = disabled || active;
  startButton.disabled = disabled || active;
  pumpButton.disabled = disabled || !active;
  cashoutButton.disabled = disabled || !active;
  element('#pump-count').textContent = `${pumps} / 25`;
  element('#multiplier').textContent = popped
    ? '0.00x'
    : multiplier(round?.multiplierMicros ?? 1_000_000);
  element('#payout').textContent = money(round?.cashoutCents ?? 0);
  const chance = round ? round.nextPopProbability : getNextPopProbability(0);
  element('#pop-chance').textContent =
    chance === null ? '-' : `${(chance * 100).toFixed(1)}%`;

  const balloon = element('#balloon');
  balloon.hidden = popped;
  balloon.style.width = `${50 + pumps * 6}px`;
  balloon.style.height = `${60 + pumps * 7}px`;
  balloon.setAttribute('aria-label', `Balloon after ${pumps} pumps`);

  let status = 'Start a round to play.';
  if (active) {
    status =
      pumps === 0
        ? 'Round started. Pump the balloon, or cash out now at 0.97x.'
        : 'Round active. Pump again or cash out.';
  } else if (popped) {
    status = `Balloon popped on pump ${pumps}. Your bet was lost.`;
  } else if (round) {
    status = `Cashed out for ${money(round.payoutCents)}.`;
    if (round.settlementReason === 'limit') status += ' Maximum pumps reached.';
  }
  element('#round-status').textContent = status;

  element('#round-proof').hidden = !round;
  element('#seed-hash').textContent = round?.serverSeedHash ?? '';
  element('#server-seed').textContent =
    round?.proof?.serverSeed ?? 'Revealed when the round ends.';
  renderHistory();
}

function renderHistory(): void {
  const body = element<HTMLTableSectionElement>('#history-body');
  body.replaceChildren();
  if (!state?.history.length) {
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'No completed rounds yet.';
    body.insertRow().append(cell);
    return;
  }
  for (const round of state.history) {
    const row = body.insertRow();
    const values = [
      round.status === 'popped' ? 'Popped' : 'Cashed out',
      money(round.betCents),
      round.status === 'popped' ? '0.00x' : multiplier(round.multiplierMicros),
      money(round.payoutCents),
    ];
    for (const value of values) row.insertCell().textContent = value;
  }
}

async function loadState(): Promise<void> {
  state = await api('/pump/state');
  connected = true;
}

async function act(path: string, body: object): Promise<void> {
  if (busy || !connected) return;
  busy = true;
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
      setMessage(
        'Connection interrupted. Refresh the page to restore your round.',
      );
    }
  } finally {
    busy = false;
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

async function connect(): Promise<void> {
  busy = true;
  render();
  try {
    await loadState();
  } catch {
    setMessage('Could not reach the game. Refresh the page to try again.');
  } finally {
    busy = false;
    render();
  }
}

void connect();
