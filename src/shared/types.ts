export type RoundStatus = 'active' | 'popped' | 'cashed_out';
export type SettlementReason = 'cashout' | 'limit' | 'pop';

export interface RoundProof {
  serverSeed: string;
  randomValueHex: string;
  popAtPump: number;
}

export interface RoundView {
  id: string;
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
