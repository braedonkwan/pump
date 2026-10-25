import { deriveOutcome } from '../src/server/fairness.js';
import {
  CURRENT_CURVE_VERSION,
  type CurveVersion,
} from '../src/engine/PumpEngine.js';

export function seedForPop(
  roundId: string,
  popAtPump: number,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
): string {
  for (let attempt = 0; attempt < 100_000; attempt++) {
    const seed = attempt.toString(16).padStart(64, '0');
    if (deriveOutcome(roundId, seed, curveVersion).popAtPump === popAtPump)
      return seed;
  }
  throw new Error('Could not find a deterministic test seed.');
}
