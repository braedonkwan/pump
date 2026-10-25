import { createHash, randomBytes } from 'node:crypto';
import { getPopPoint } from '../engine/PumpEngine.js';
import {
  CURRENT_CURVE_VERSION,
  type CurveVersion,
} from '../shared/settings.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function deriveOutcome(
  roundId: string,
  serverSeed: string,
  curveVersion: CurveVersion = CURRENT_CURVE_VERSION,
) {
  const randomValueHex = sha256(
    `pump:v${curveVersion}:${roundId}:${serverSeed}`,
  );
  return {
    randomValueHex,
    popAtPump: getPopPoint(BigInt(`0x${randomValueHex}`), curveVersion),
  };
}
