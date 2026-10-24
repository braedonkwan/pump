import { createHash, randomBytes } from 'node:crypto';
import { getPopPoint } from '../engine/PumpEngine.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function deriveOutcome(roundId: string, serverSeed: string) {
  const randomValueHex = sha256(`pump:v1:${roundId}:${serverSeed}`);
  return {
    randomValueHex,
    popAtPump: getPopPoint(BigInt(`0x${randomValueHex}`)),
  };
}
