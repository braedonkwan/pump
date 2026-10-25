import {
  MIN_BET_CENTS,
  MAX_BET_CENTS,
  MAX_PUMPS,
  MAX_MULTIPLIER_MICROS,
  MULTIPLIER_SCALE,
  RANDOM_SPACE,
  RANDOM_BITS,
  CURRENT_CURVE_VERSION,
  LEGACY_CURVE_VERSION,
  CENT_ALIGNED_CURVE_VERSION,
  RTP_NUMERATOR,
  RTP_DENOMINATOR,
  BASIS_POINT_SCALE,
  CURVE_SETTINGS,
  CENT_ALIGNED_CURVE_SETTINGS,
  BET_STEP_CENTS,
  MIN_RTP_NUMERATOR,
  MIN_RTP_DENOMINATOR,
  PROBABILITY_SCALE,
  LEGACY_CURVE_SETTINGS,
  type CurveVersion,
} from '../shared/settings.js';
// Preserve the engine's public exports for existing consumers.
export {
  MIN_BET_CENTS,
  MAX_BET_CENTS,
  MAX_PUMPS,
  MAX_MULTIPLIER_MICROS,
  MULTIPLIER_SCALE,
  RANDOM_SPACE,
  CURRENT_CURVE_VERSION,
  type CurveVersion,
} from '../shared/settings.js';
export interface LadderStep {
  readonly pumps: number;
  readonly survivalThreshold: bigint;
  readonly multiplierMicros: number;
}

function createLegacyLadder(): readonly LadderStep[] {
  const steps: LadderStep[] = [];
  let threshold = RANDOM_SPACE;

  for (let pumps = 0; pumps <= MAX_PUMPS; pumps++) {
    if (pumps > 0) {
      // Conditional pop risk increases from 4% to 40%, in 1.5-point steps.
      threshold =
        (threshold *
          BigInt(
            LEGACY_CURVE_SETTINGS.initialSurvivalNumerator -
              LEGACY_CURVE_SETTINGS.survivalDecreaseNumerator * (pumps - 1),
          )) /
        LEGACY_CURVE_SETTINGS.survivalDenominator;
    }

    const multiplierMicros = Number(
      (RTP_NUMERATOR * RANDOM_SPACE * MULTIPLIER_SCALE) /
        (RTP_DENOMINATOR * threshold),
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

function divideUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function createLadder(strictRisk = false): readonly LadderStep[] {
  const settings = strictRisk ? CURVE_SETTINGS : CENT_ALIGNED_CURVE_SETTINGS;
  const minimumBet = BigInt(MIN_BET_CENTS);
  const steps: LadderStep[] = [
    Object.freeze({
      pumps: 0,
      survivalThreshold: RANDOM_SPACE,
      multiplierMicros: Number(MULTIPLIER_SCALE),
    }),
  ];
  let previousPayout = minimumBet;
  let previousSurvivalNumerator = 1n;
  let previousSurvivalDenominator = 1n;
  for (let pumps = 1; pumps <= MAX_PUMPS; pumps++) {
    // Select whole-cent payouts at the minimum bet, then derive their odds.
    const baseSurvivalBps = BigInt(
      settings.initialSurvivalBps - settings.survivalDecreaseBps * (pumps - 1),
    );
    const desiredPayout =
      pumps === 1
        ? divideUp(
            RTP_NUMERATOR * minimumBet * BASIS_POINT_SCALE,
            RTP_DENOMINATOR * baseSurvivalBps,
          )
        : divideUp(previousPayout * BASIS_POINT_SCALE, baseSurvivalBps);
    const monotonicPayout = divideUp(
      previousPayout * previousSurvivalDenominator,
      previousSurvivalNumerator,
    );
    const payout =
      strictRisk && pumps === MAX_PUMPS
        ? (BigInt(MAX_MULTIPLIER_MICROS) * minimumBet) / MULTIPLIER_SCALE
        : desiredPayout > monotonicPayout
          ? desiredPayout
          : monotonicPayout;
    const multiplierMicros = Number((payout * MULTIPLIER_SCALE) / minimumBet);
    if (multiplierMicros > MAX_MULTIPLIER_MICROS) {
      throw new Error('The configured curve exceeds the multiplier limit.');
    }
    let threshold =
      (RTP_NUMERATOR * RANDOM_SPACE * minimumBet) / (RTP_DENOMINATOR * payout);
    if (strictRisk && pumps > 1) {
      const previous = steps[pumps - 1]!;
      const beforePrevious = steps[pumps - 2]!;
      // Bound the next survival ratio so conditional pop risk rises every pump.
      // Keep whole-cent payouts and accept at most 0.01 percentage points of RTP loss.
      const riskBound =
        (previous.survivalThreshold *
          (previous.survivalThreshold * PROBABILITY_SCALE -
            beforePrevious.survivalThreshold *
              CURVE_SETTINGS.minimumPopIncreaseMicros)) /
        (beforePrevious.survivalThreshold * PROBABILITY_SCALE);
      if (riskBound < threshold) threshold = riskBound;
    }
    if (
      strictRisk &&
      MIN_RTP_DENOMINATOR * threshold * payout <
        MIN_RTP_NUMERATOR * RANDOM_SPACE * minimumBet
    ) {
      throw new Error('The configured curve falls below the RTP floor.');
    }
    steps.push(
      Object.freeze({
        pumps,
        survivalThreshold: threshold,
        multiplierMicros,
      }),
    );
    previousSurvivalNumerator =
      pumps === 1 ? RTP_NUMERATOR * minimumBet : previousPayout;
    previousSurvivalDenominator =
      pumps === 1 ? RTP_DENOMINATOR * payout : payout;
    previousPayout = payout;
  }
  return Object.freeze(steps);
}

const LEGACY_LADDER = createLegacyLadder();
const CENT_ALIGNED_LADDER = createLadder();
export const LADDER = createLadder(true);

function getLadder(curveVersion: CurveVersion): readonly LadderStep[] {
  if (curveVersion === LEGACY_CURVE_VERSION) return LEGACY_LADDER;
  if (curveVersion === CENT_ALIGNED_CURVE_VERSION) return CENT_ALIGNED_LADDER;
  if (curveVersion === CURRENT_CURVE_VERSION) return LADDER;
  throw new RangeError('Unsupported curve version.');
}

export function getStep(
  pumps: number,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
): LadderStep {
  if (!Number.isInteger(pumps) || pumps < 0 || pumps > MAX_PUMPS) {
    throw new RangeError('Invalid pump count.');
  }
  const step = getLadder(curveVersion)[pumps];
  if (!step) throw new Error('The ladder is incomplete.');
  return step;
}

export function validateBet(
  betCents: number,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
): void {
  if (
    !Number.isSafeInteger(betCents) ||
    betCents < MIN_BET_CENTS ||
    betCents > MAX_BET_CENTS ||
    (curveVersion === CURRENT_CURVE_VERSION && betCents % BET_STEP_CENTS !== 0)
  ) {
    throw new RangeError(
      curveVersion === CURRENT_CURVE_VERSION
        ? 'Bet must be between $0.10 and $1,000.00 in $0.10 increments.'
        : 'Bet must be between $0.10 and $1,000.00 in whole cents.',
    );
  }
}

export function getPayoutCents(
  betCents: number,
  pumps: number,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
): number {
  validateBet(betCents, curveVersion);
  const step = getStep(pumps, curveVersion);
  if (pumps === 0) return betCents;
  // Floor fractional cents so payment never exceeds the curve's calculated amount.
  // The current ten-cent stakes pay whole cents; archived odd-cent rounds still floor.
  return Number(
    (BigInt(betCents) * BigInt(step.multiplierMicros)) / MULTIPLIER_SCALE,
  );
}

export function getNextPopProbability(
  pumps: number,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
): number | null {
  const current = getStep(pumps, curveVersion);
  if (pumps === MAX_PUMPS) return null;
  const next = getStep(pumps + 1, curveVersion);
  return (
    Number(current.survivalThreshold - next.survivalThreshold) /
    Number(current.survivalThreshold)
  );
}

// MAX_PUMPS + 1 means the balloon survives the entire flight.
export function getPopPoint(
  randomValue: bigint,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
): number {
  if (randomValue < 0n || randomValue >= RANDOM_SPACE) {
    throw new RangeError(
      `Random value must be an unsigned ${RANDOM_BITS}-bit integer.`,
    );
  }
  return (
    getLadder(curveVersion).find(
      (step) => randomValue >= step.survivalThreshold,
    )?.pumps ?? MAX_PUMPS + 1
  );
}

export interface PumpOutcome {
  pumps: number;
  status: 'active' | 'popped' | 'cashed_out';
}

export function pumpRound(
  pumps: number,
  popAtPump: number,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
): PumpOutcome {
  getStep(pumps, curveVersion);
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
    getStep(next, curveVersion).multiplierMicros >= MAX_MULTIPLIER_MICROS
  ) {
    return { pumps: next, status: 'cashed_out' };
  }
  return { pumps: next, status: 'active' };
}
