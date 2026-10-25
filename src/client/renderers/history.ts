import type { RoundView } from '../../shared/types.js';
import { MAX_PUMPS } from '../../shared/settings.js';
import { element, icon } from '../dom.js';
import { money, multiplier } from '../format.js';
export function createHistoryRenderer(showProof: (round: RoundView) => void) {
  let renderedHistory: readonly RoundView[] | null = null;
  return function renderHistory(history: readonly RoundView[]): void {
    const previous = renderedHistory;
    if (
      previous &&
      history.length === previous.length &&
      history.every(
        (round, index) =>
          round.id === previous[index]?.id &&
          round.version === previous[index]?.version &&
          round.mode === previous[index]?.mode,
      )
    )
      return;
    renderedHistory = history;
    const body = element<HTMLTableSectionElement>('#history-body');
    const rows = document.createDocumentFragment();
    if (!history.length) {
      const row = document.createElement('tr');
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.className = 'empty-history';
      const label = document.createElement('span');
      label.textContent = 'Your first flight is waiting.';
      const detail = document.createElement('small');
      detail.textContent = 'Start a round to leave the ground.';
      cell.append(icon('wind'), label, detail);
      body.replaceChildren(row);
      return;
    }
    for (const round of history) {
      const row = document.createElement('tr');
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
          round.mode === 'testing'
            ? round.status === 'popped'
              ? 'Test pop'
              : 'Test cashout'
            : round.status === 'popped'
              ? 'Popped'
              : 'Cashed out',
        ),
      );
      row.insertCell().append(badge);
      row.insertCell().textContent = `${round.pumps} / ${MAX_PUMPS}`;
      row.insertCell().textContent = money(round.betCents);
      row.insertCell().textContent = `${round.status === 'popped' ? '0.00' : multiplier(round.multiplierMicros)}×`;
      const payout = row.insertCell();
      payout.textContent = money(round.payoutCents);
      if (round.status === 'cashed_out') payout.className = 'history-payout';
      rows.append(row);
    }
    body.replaceChildren(rows);
  };
}
