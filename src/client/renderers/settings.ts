import {
  MAX_PUMPS,
  MIN_BET_CENTS,
  MAX_BET_CENTS,
  TARGET_RTP_PERCENT,
  BET_STEP_CENTS,
  MIN_RTP_NUMERATOR,
  MIN_RTP_DENOMINATOR,
  INITIAL_BALANCE_CENTS,
} from '../../shared/settings.js';
import { element } from '../dom.js';
import { money } from '../format.js';

export function renderSettings(): void {
  for (const [selector, value] of [
    ['[data-max-pumps]', String(MAX_PUMPS)],
    ['[data-min-bet]', money(MIN_BET_CENTS)],
    ['[data-max-bet]', money(MAX_BET_CENTS)],
    ['[data-demo-balance]', money(INITIAL_BALANCE_CENTS)],
    ['[data-rtp-percent]', String(TARGET_RTP_PERCENT)],
    ['[data-bet-step]', money(BET_STEP_CENTS)],
    [
      '[data-min-rtp]',
      ((Number(MIN_RTP_NUMERATOR) / Number(MIN_RTP_DENOMINATOR)) * 100).toFixed(
        2,
      ),
    ],
  ] as const) {
    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = value;
    });
  }
  element('#altimeter').setAttribute('aria-valuemax', String(MAX_PUMPS));
  element('#journey-segments').style.setProperty(
    '--pump-count',
    String(MAX_PUMPS),
  );
}
