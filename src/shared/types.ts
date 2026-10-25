import type { CurveVersion } from './settings.js';

export type RoundStatus = 'active' | 'popped' | 'cashed_out';
export type SettlementReason = 'cashout' | 'limit' | 'pop';
export type RoundMode = 'normal' | 'testing' | 'unknown';

export interface RoundProof {
  serverSeed: string;
  randomValueHex: string;
  popAtPump: number;
}

export interface RoundView {
  id: string;
  curveVersion: CurveVersion;
  mode: RoundMode;
  betCents: number;
  pumps: number;
  version: number;
  status: RoundStatus;
  settlementReason: SettlementReason | null;
  multiplierMicros: number;
  cashoutCents: number;
  payoutCents: number;
  nextPopProbability: number | null;
  serverSeedHash: string;
  proof: RoundProof | null;
  createdAt: string;
}

export interface WalletView {
  balanceCents: number;
}

export interface GameState {
  // Default for new rounds; a running round uses its own recorded mode.
  poppingDisabled: boolean;
  wallet: WalletView;
  round: RoundView | null;
  history: RoundView[];
}

export interface StartRequest {
  betCents: number;
  requestId: string;
}

export interface RoundRequest {
  roundId: string;
  expectedVersion: number;
}
