import type { GameState } from '../shared/types.js';

const REQUEST_TIMEOUT_MS = 10_000;
export type GameRequest = (path: string, body?: object) => Promise<GameState>;

export const requestGameState: GameRequest = async (path, body) => {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
};
