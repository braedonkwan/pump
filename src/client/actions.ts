import type { GameState } from '../shared/types.js';
import { requestGameState, type GameRequest } from './api.js';

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

  constructor(
    private readonly callbacks: ActionCallbacks,
    private readonly request: GameRequest = requestGameState,
  ) {}

  async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.callbacks.message('Connecting to your wallet…');
    this.callbacks.changed();
    try {
      await this.loadState();
      this.callbacks.message('');
    } catch {
      this.connected = false;
      this.callbacks.message(
        'Could not reach the game. Reconnect to try again.',
      );
    } finally {
      this.busy = false;
      this.callbacks.changed();
    }
  }

  async start(betCents: number): Promise<void> {
    if (this.callbacks.isSettling() || this.state?.round?.status === 'active')
      return;
    await this.act('start', { betCents, requestId: crypto.randomUUID() });
  }

  async play(action: 'pump' | 'cashout'): Promise<void> {
    const round = this.state?.round;
    if (round?.status !== 'active') return;
    await this.act(action, {
      roundId: round.id,
      expectedVersion: round.version,
    });
  }

  private async loadState(): Promise<void> {
    this.state = await this.request('/pump/state');
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
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Could not complete that request.';
      // A lost response can still have committed. Restore before allowing another move.
      try {
        await this.loadState();
        this.callbacks.message(message);
      } catch {
        this.connected = false;
        this.callbacks.message(
          'Connection interrupted. Reconnect to restore your flight.',
        );
      }
    } finally {
      this.busy = false;
      this.pendingAction = null;
      this.callbacks.changed();
    }
  }
}
