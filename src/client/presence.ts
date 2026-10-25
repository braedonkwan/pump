import type { GameActions } from './actions.js';
import { PRESENCE_INTERVAL_MS } from '../shared/settings.js';

export function wirePresence(actions: GameActions): void {
  const refresh = () => {
    if (document.visibilityState === 'visible') void actions.refreshPresence();
  };
  window.setInterval(refresh, PRESENCE_INTERVAL_MS);
  document.addEventListener('visibilitychange', refresh);
}
