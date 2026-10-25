import './styles.css';
import type { GameState } from '../shared/types.js';
import { GameActions } from './actions.js';
import { element } from './dom.js';
import { wireEvents } from './events.js';
import { renderSettings } from './renderers/settings.js';
import { renderControls, setMessage } from './renderers/controls.js';
import { GameDialogs } from './renderers/dialogs.js';
import { renderGame } from './renderers/game.js';
import { createHistoryRenderer } from './renderers/history.js';
import { FlightWorld } from './world.js';

const dialogs = new GameDialogs();
const renderHistory = createHistoryRenderer((round) =>
  dialogs.showProof(round),
);
const world = new FlightWorld(element('#world-scene'), () =>
  renderControls(actions, world.isSettling),
);
const actions = new GameActions({
  changed: render,
  message: setMessage,
  isSettling: () => world.isSettling,
});
let renderedState: GameState | null = null;
let restoringWorld = true;

function render(): void {
  renderControls(actions, world.isSettling);
  const { state } = actions;
  if (state === renderedState) return;
  renderedState = state;
  renderGame(state);
  renderHistory(state?.history ?? []);
  dialogs.refresh(state?.round ?? null);
  world.update(state?.round ?? null, restoringWorld);
  if (state) restoringWorld = false;
}

renderSettings();
wireEvents(actions, dialogs);
void actions.connect();
