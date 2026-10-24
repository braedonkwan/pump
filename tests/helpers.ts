import { deriveOutcome } from '../src/server/fairness.js';

export function seedForPop(roundId: string, popAtPump: number): string {
  for (let attempt = 0; attempt < 100_000; attempt++) {
    const seed = attempt.toString(16).padStart(64, '0');
    if (deriveOutcome(roundId, seed).popAtPump === popAtPump) return seed;
  }
  throw new Error('Could not find a deterministic test seed.');
}
