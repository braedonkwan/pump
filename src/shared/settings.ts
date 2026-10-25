// Game rules shared by the engine, server, and client. Keep historical curves stable.
export const MIN_BET_CENTS = 10;
export const BET_STEP_CENTS = 10;
export const MAX_BET_CENTS = 100_000;
export const CENTS_PER_DOLLAR = 100;
export const MAX_PUMPS = 25;
export const MAX_MULTIPLIER_MICROS = 1_000_000_000;
export const MULTIPLIER_SCALE = 1_000_000n;
export const RANDOM_BITS = 256n;
export const RANDOM_SPACE = 1n << RANDOM_BITS;
export const CURRENT_CURVE_VERSION = 3;
export const CENT_ALIGNED_CURVE_VERSION = 2;
export const LEGACY_CURVE_VERSION = 1;
export type CurveVersion = 1 | 2 | 3;
export const RTP_NUMERATOR = 97n;
export const RTP_DENOMINATOR = 100n;
export const TARGET_RTP_PERCENT =
  (Number(RTP_NUMERATOR) / Number(RTP_DENOMINATOR)) * 100;
export const BASIS_POINT_SCALE = 10_000n;
export const MIN_RTP_NUMERATOR = 9_699n;
export const MIN_RTP_DENOMINATOR = 10_000n;
export const PROBABILITY_SCALE = 1_000_000n;
export const CURVE_SETTINGS = Object.freeze({
  initialSurvivalBps: 9_600,
  survivalDecreaseBps: 123,
  minimumPopIncreaseMicros: 80n,
});
export const CENT_ALIGNED_CURVE_SETTINGS = Object.freeze({
  initialSurvivalBps: 9_600,
  survivalDecreaseBps: 100,
});
export const LEGACY_CURVE_SETTINGS = Object.freeze({
  initialSurvivalNumerator: 192,
  survivalDecreaseNumerator: 3,
  survivalDenominator: 200n,
});
