import type { GameState, RoomState } from '../shared/types.js';
import { PRESENCE_RECENT_REQUEST_MS } from '../shared/settings.js';
import {
  ApiError,
  requestGameState,
  requestPresence,
  type GameRequest,
} from './api.js';

export type GameAction = 'start' | 'pump' | 'cashout';
export interface ActionState {
  readonly state: GameState | null;
  readonly busy: boolean;
  readonly connected: boolean;
  readonly pendingAction: GameAction | null;
}
interface ActionCallbacks {
  changed(): void;
  message(message: string): void;
  isSettling(): boolean;
}

// Own request serialization and recovery; DOM rendering and events live elsewhere.
export class GameActions implements ActionState {
  state: GameState | null = null;
  busy = false;
  connected = false;
  pendingAction: GameAction | null = null;
  private lastContact = 0;
  private presencePending = false;

  constructor(
    private readonly callbacks: ActionCallbacks,
    private readonly request: GameRequest = requestGameState,
    private readonly heartbeat: () => Promise<RoomState> = requestPresence,
  ) {}

  async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.callbacks.message('Connecting to your wallet…');
    this.callbacks.changed();
    try {
      await this.loadState();
      this.showRoomMessage();
    } catch (error) {
      this.connected = false;
      this.callbacks.message(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the game. Reconnect to try again.',
      );
    } finally {
      this.busy = false;
      this.callbacks.changed();
    }
  }

  async start(betCents: number): Promise<void> {
    if (
      this.callbacks.isSettling() ||
      this.state?.round?.status === 'active' ||
      this.state?.room?.admitted === false
    )
      return;
    await this.act('start', { betCents, requestId: crypto.randomUUID() });
  }

  async play(action: 'pump' | 'cashout'): Promise<void> {
    const round = this.state?.round;
    if (round?.status !== 'active') return;
    if (action === 'pump' && this.state?.room?.admitted === false) return;
    await this.act(action, {
      roundId: round.id,
      expectedVersion: round.version,
    });
  }

  private async loadState(): Promise<void> {
    this.state = await this.request('/pump/state');
    this.lastContact = Date.now();
    this.connected = true;
  }

  private async act(action: GameAction, body: object): Promise<void> {
    if (this.busy || !this.connected) return;
    this.busy = true;
    this.pendingAction = action;
    this.callbacks.message('');
    this.callbacks.changed();
    try {
      this.state = await this.request(`/pump/${action}`, body);
      this.lastContact = Date.now();
      this.showRoomMessage();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Could not complete that request.';
      // A lost response can still have committed. Restore before allowing another move.
      try {
        await this.loadState();
        this.callbacks.message(message);
      } catch (recoveryError) {
        this.connected = false;
        this.callbacks.message(
          recoveryError instanceof ApiError
            ? recoveryError.message
            : 'Connection interrupted. Reconnect to restore your flight.',
        );
      }
    } finally {
      this.busy = false;
      this.pendingAction = null;
      this.callbacks.changed();
    }
  }

  async refreshPresence(): Promise<void> {
    const state = this.state;
    if (
      !state?.room ||
      !this.connected ||
      this.busy ||
      this.presencePending ||
      Date.now() - this.lastContact < PRESENCE_RECENT_REQUEST_MS
    )
      return;
    this.presencePending = true;
    try {
      const room = await this.heartbeat();
      if (this.state !== state || this.busy) return;
      this.state = { ...state, room };
      this.lastContact = Date.now();
      this.showRoomMessage();
      this.callbacks.changed();
    } catch (error) {
      if (this.state !== state || this.busy) return;
      this.connected = false;
      this.callbacks.message(
        error instanceof ApiError
          ? error.message
          : 'Connection interrupted. Reconnect to restore your flight.',
      );
      this.callbacks.changed();
    } finally {
      this.presencePending = false;
    }
  }

  private showRoomMessage(): void {
    this.callbacks.message(
      this.state?.room?.admitted === false
        ? this.state.round?.status === 'active'
          ? 'Game full. You can still cash out your saved flight. Try again shortly to keep playing.'
          : 'Game full. Your balance is saved. Try again shortly to keep playing.'
        : '',
    );
  }
}
