export const MIN_BET_CENTS = 10;
export const MAX_BET_CENTS = 100_000;
export const MAX_PUMPS = 25;
export const MAX_MULTIPLIER_MICROS = 1_000_000_000;
export const MULTIPLIER_SCALE = 1_000_000n;
export const RANDOM_SPACE = 1n << 256n;

export interface LadderStep {
  readonly pumps: number;
  readonly survivalThreshold: bigint;
  readonly multiplierMicros: number;
}

function createLadder(): readonly LadderStep[] {
  const steps: LadderStep[] = [];
  let threshold = RANDOM_SPACE;

  for (let pumps = 0; pumps <= MAX_PUMPS; pumps++) {
    if (pumps > 0) {
      // Conditional pop risk increases from 4% to 40%, in 1.5-point steps.
      threshold = (threshold * BigInt(192 - 3 * (pumps - 1))) / 200n;
    }

    const multiplierMicros = Number(
      (97n * RANDOM_SPACE * MULTIPLIER_SCALE) / (100n * threshold),
    );
    if (multiplierMicros > MAX_MULTIPLIER_MICROS) {
      throw new Error('The configured curve exceeds the multiplier limit.');
    }
    steps.push(
      Object.freeze({ pumps, survivalThreshold: threshold, multiplierMicros }),
    );
  }

  return Object.freeze(steps);
}

export const LADDER = createLadder();

export function getStep(pumps: number): LadderStep {
  if (!Number.isInteger(pumps) || pumps < 0 || pumps > MAX_PUMPS) {
    throw new RangeError('Invalid pump count.');
  }
  const step = LADDER[pumps];
  if (!step) throw new Error('The ladder is incomplete.');
  return step;
}

export function validateBet(betCents: number): void {
  if (
    !Number.isSafeInteger(betCents) ||
    betCents < MIN_BET_CENTS ||
    betCents > MAX_BET_CENTS
  ) {
    throw new RangeError(
      'Bet must be between $0.10 and $1,000.00 in whole cents.',
    );
  }
}

export function getPayoutCents(betCents: number, pumps: number): number {
  validateBet(betCents);
  return Number(
    (BigInt(betCents) * BigInt(getStep(pumps).multiplierMicros)) /
      MULTIPLIER_SCALE,
  );
}

export function getNextPopProbability(pumps: number): number | null {
  const current = getStep(pumps);
  if (pumps === MAX_PUMPS) return null;
  const next = getStep(pumps + 1);
  return (
    Number(current.survivalThreshold - next.survivalThreshold) /
    Number(current.survivalThreshold)
  );
}

// A value of 26 means the balloon survives all 25 pumps.
export function getPopPoint(randomValue: bigint): number {
  if (randomValue < 0n || randomValue >= RANDOM_SPACE) {
    throw new RangeError('Random value must be an unsigned 256-bit integer.');
  }
  return (
    LADDER.find((step) => randomValue >= step.survivalThreshold)?.pumps ??
    MAX_PUMPS + 1
  );
}

export interface PumpOutcome {
  pumps: number;
  status: 'active' | 'popped' | 'cashed_out';
}

export function pumpRound(pumps: number, popAtPump: number): PumpOutcome {
  getStep(pumps);
  if (
    pumps === MAX_PUMPS ||
    !Number.isInteger(popAtPump) ||
    popAtPump <= pumps ||
    popAtPump > MAX_PUMPS + 1
  ) {
    throw new RangeError('Cannot pump an invalid or completed round.');
  }

  const next = pumps + 1;
  if (next === popAtPump) return { pumps: next, status: 'popped' };
  if (
    next === MAX_PUMPS ||
    getStep(next).multiplierMicros >= MAX_MULTIPLIER_MICROS
  ) {
    return { pumps: next, status: 'cashed_out' };
  }
  return { pumps: next, status: 'active' };
}
