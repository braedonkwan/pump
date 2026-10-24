import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  getNextPopProbability,
  getPayoutCents,
  getStep,
  MAX_PUMPS,
  pumpRound,
  validateBet,
} from '../engine/PumpEngine.js';
import type {
  GameState,
  RoundRequest,
  RoundStatus,
  RoundView,
  SettlementReason,
  StartRequest,
  WalletView,
} from '../shared/types.js';
import { transaction } from './database.js';
import { GameError } from './errors.js';
import { createServerSeed, deriveOutcome, sha256 } from './fairness.js';

interface RoundRow extends Record<string, SQLOutputValue> {
  id: string;
  player_id: string;
  bet_cents: number;
  pumps: number;
  version: number;
  status: RoundStatus;
  settlement_reason: SettlementReason | null;
  payout_cents: number;
  server_seed: string;
  server_seed_hash: string;
  pop_at_pump: number;
  created_at: string;
}

export class PumpService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly seedFactory: (
      roundId: string,
    ) => string = createServerSeed,
    private readonly options: { disablePopping?: boolean } = {},
  ) {}

  getSession(token: string | undefined): {
    playerId: string;
    newToken?: string;
  } {
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const player = this.database
        .prepare('SELECT id FROM players WHERE session_hash = ?')
        .get(sha256(token));
      if (player) return { playerId: String(player.id) };
    }

    const newToken = randomBytes(32).toString('hex');
    const playerId = randomUUID();
    this.database
      .prepare('INSERT INTO players (id, session_hash) VALUES (?, ?)')
      .run(playerId, sha256(newToken));
    return { playerId, newToken };
  }

  getWallet(playerId: string): WalletView {
    const player = this.database
      .prepare('SELECT balance_cents FROM players WHERE id = ?')
      .get(playerId);
    if (!player) throw new GameError(404, 'Player not found.');
    return { balanceCents: Number(player.balance_cents) };
  }

  getHistory(playerId: string): RoundView[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM rounds WHERE player_id = ? AND status != 'active' ORDER BY rowid DESC LIMIT 10",
      )
      .all(playerId) as RoundRow[];
    return rows.map((round) => this.toView(round));
  }

  getState(playerId: string, roundId?: string): GameState {
    const current = roundId
      ? this.findRound(playerId, roundId)
      : (this.database
          .prepare(
            "SELECT * FROM rounds WHERE player_id = ? ORDER BY (status = 'active') DESC, rowid DESC LIMIT 1",
          )
          .get(playerId) as RoundRow | undefined);
    return {
      poppingDisabled: this.options.disablePopping ?? false,
      wallet: this.getWallet(playerId),
      round: current ? this.toView(current) : null,
      history: this.getHistory(playerId),
    };
  }

  start(playerId: string, request: StartRequest): GameState {
    try {
      validateBet(request.betCents);
    } catch {
      throw new GameError(
        400,
        'Bet must be between $0.10 and $1,000.00 in whole cents.',
      );
    }
    if (
      typeof request.requestId !== 'string' ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(request.requestId)
    ) {
      throw new GameError(
        400,
        'A requestId of 8 to 100 letters, digits, or dashes is required.',
      );
    }

    return transaction(this.database, () => {
      const previous = this.database
        .prepare('SELECT * FROM rounds WHERE player_id = ? AND request_key = ?')
        .get(playerId, request.requestId) as RoundRow | undefined;
      if (previous) {
        if (previous.bet_cents !== request.betCents) {
          throw new GameError(
            409,
            'That requestId was already used for a different bet.',
          );
        }
        return this.getState(playerId, previous.id);
      }
      const active = this.database
        .prepare(
          "SELECT id FROM rounds WHERE player_id = ? AND status = 'active'",
        )
        .get(playerId);
      if (active) throw new GameError(409, 'Finish your current round first.');

      const debit = this.database
        .prepare(
          'UPDATE players SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?',
        )
        .run(request.betCents, playerId, request.betCents);
      if (debit.changes !== 1)
        throw new GameError(409, 'Insufficient balance.');

      const roundId = randomUUID();
      const serverSeed = this.seedFactory(roundId);
      const { popAtPump } = deriveOutcome(roundId, serverSeed);
      this.database
        .prepare(
          `INSERT INTO rounds
            (id, player_id, request_key, bet_cents, server_seed, server_seed_hash, pop_at_pump, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          roundId,
          playerId,
          request.requestId,
          request.betCents,
          serverSeed,
          sha256(serverSeed),
          popAtPump,
          new Date().toISOString(),
        );
      return this.getState(playerId, roundId);
    });
  }

  pump(playerId: string, request: RoundRequest): GameState {
    return this.updateRound(playerId, request, 'pump');
  }

  cashout(playerId: string, request: RoundRequest): GameState {
    return this.updateRound(playerId, request, 'cashout');
  }

  private updateRound(
    playerId: string,
    request: RoundRequest,
    action: 'pump' | 'cashout',
  ): GameState {
    if (
      typeof request.roundId !== 'string' ||
      !Number.isSafeInteger(request.expectedVersion) ||
      request.expectedVersion < 0
    ) {
      throw new GameError(
        400,
        'A roundId and a nonnegative expectedVersion are required.',
      );
    }

    return transaction(this.database, () => {
      const round = this.findRound(playerId, request.roundId);
      if (!round) throw new GameError(404, 'Round not found.');

      // Only a retry of the same manual cashout is idempotent. A simultaneous
      // pump that auto-settles must still make the competing cashout conflict.
      if (
        action === 'cashout' &&
        round.settlement_reason === 'cashout' &&
        round.version === request.expectedVersion + 1
      ) {
        return this.getState(playerId, round.id);
      }
      if (
        round.status !== 'active' ||
        round.version !== request.expectedVersion
      ) {
        throw new GameError(
          409,
          'This round changed. Your game has been refreshed; try again.',
        );
      }

      // Testing may have carried this round past its seeded pop point.
      const outcome =
        action === 'pump'
          ? pumpRound(
              round.pumps,
              this.options.disablePopping
                ? MAX_PUMPS + 1
                : Math.max(round.pumps + 1, round.pop_at_pump),
            )
          : { pumps: round.pumps, status: 'cashed_out' as const };
      const reason: SettlementReason | null =
        outcome.status === 'popped'
          ? 'pop'
          : outcome.status === 'cashed_out'
            ? action === 'cashout'
              ? 'cashout'
              : 'limit'
            : null;
      const payoutCents =
        outcome.status === 'cashed_out'
          ? getPayoutCents(round.bet_cents, outcome.pumps)
          : 0;

      const updated = this.database
        .prepare(
          `UPDATE rounds SET pumps = ?, status = ?, settlement_reason = ?,
            payout_cents = ?, ended_at = ?, version = version + 1
           WHERE id = ? AND player_id = ? AND status = 'active' AND version = ?`,
        )
        .run(
          outcome.pumps,
          outcome.status,
          reason,
          payoutCents,
          reason ? new Date().toISOString() : null,
          round.id,
          playerId,
          request.expectedVersion,
        );
      if (updated.changes !== 1)
        throw new GameError(409, 'This round already changed.');
      if (payoutCents > 0) {
        this.database
          .prepare(
            'UPDATE players SET balance_cents = balance_cents + ? WHERE id = ?',
          )
          .run(payoutCents, playerId);
      }
      return this.getState(playerId, round.id);
    });
  }

  private findRound(playerId: string, roundId: string): RoundRow | undefined {
    return this.database
      .prepare('SELECT * FROM rounds WHERE id = ? AND player_id = ?')
      .get(roundId, playerId) as RoundRow | undefined;
  }

  private toView(round: RoundRow): RoundView {
    const active = round.status === 'active';
    return {
      id: round.id,
      betCents: round.bet_cents,
      pumps: round.pumps,
      version: round.version,
      status: round.status,
      settlementReason: round.settlement_reason,
      multiplierMicros: getStep(round.pumps).multiplierMicros,
      cashoutCents: active
        ? getPayoutCents(round.bet_cents, round.pumps)
        : round.payout_cents,
      payoutCents: round.payout_cents,
      nextPopProbability: active
        ? this.options.disablePopping
          ? 0
          : round.pop_at_pump <= round.pumps
            ? 1
            : getNextPopProbability(round.pumps)
        : null,
      serverSeedHash: round.server_seed_hash,
      proof: active
        ? null
        : {
            serverSeed: round.server_seed,
            ...deriveOutcome(round.id, round.server_seed),
          },
      createdAt: round.created_at,
    };
  }
}
