import {
  MIN_BET_CENTS,
  MAX_BET_CENTS,
  MAX_PUMPS,
  INITIAL_BALANCE_CENTS,
} from '../shared/settings.js';
import { transaction, type GameDatabase } from './storage.js';

export function roundsTableSQL(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      request_key TEXT NOT NULL,
      curve_version INTEGER NOT NULL DEFAULT 1 CHECK (curve_version IN (1, 2, 3)),
      mode TEXT NOT NULL DEFAULT 'unknown' CHECK (mode IN ('normal', 'testing', 'unknown')),
      bet_cents INTEGER NOT NULL CHECK (bet_cents BETWEEN ${MIN_BET_CENTS} AND ${MAX_BET_CENTS}),
      pumps INTEGER NOT NULL DEFAULT 0 CHECK (pumps BETWEEN 0 AND ${MAX_PUMPS}),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'popped', 'cashed_out')),
      settlement_reason TEXT CHECK (settlement_reason IN ('cashout', 'limit', 'pop')),
      payout_cents INTEGER NOT NULL DEFAULT 0 CHECK (payout_cents >= 0),
      server_seed TEXT NOT NULL,
      server_seed_hash TEXT NOT NULL,
      pop_at_pump INTEGER NOT NULL CHECK (pop_at_pump BETWEEN 1 AND ${MAX_PUMPS + 1}),
      created_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE (player_id, request_key)
    );`;
}

export function initializeGameSchema(database: GameDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL UNIQUE,
      balance_cents INTEGER NOT NULL DEFAULT ${INITIAL_BALANCE_CENTS}
        CHECK (balance_cents >= 0 AND balance_cents <= 9007199254740991)
    );
    ${roundsTableSQL('rounds')}
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_round_per_player
      ON rounds(player_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS player_round_order ON rounds(player_id);
    CREATE INDEX IF NOT EXISTS completed_round_order
      ON rounds(player_id) WHERE status != 'active';
    DROP INDEX IF EXISTS round_history;
  `);
}

export function initializeLedger(database: GameDatabase): void {
  if (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wallet_ledger'",
      )
      .get()
  )
    return;

  transaction(database, () => {
    database.exec(`
      CREATE TABLE wallet_ledger (
        id INTEGER PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        player_id TEXT NOT NULL REFERENCES players(id),
        round_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('opening', 'bet', 'payout', 'refill')),
        delta_cents INTEGER NOT NULL CHECK (delta_cents BETWEEN -9007199254740991 AND 9007199254740991),
        balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents BETWEEN 0 AND 9007199254740991),
        created_at TEXT NOT NULL
      );
      CREATE INDEX ledger_player_order ON wallet_ledger(player_id, id);
      CREATE TRIGGER ledger_no_update BEFORE UPDATE ON wallet_ledger
        BEGIN SELECT RAISE(ABORT, 'Wallet ledger is append-only'); END;
      CREATE TRIGGER ledger_no_delete BEFORE DELETE ON wallet_ledger
        BEGIN SELECT RAISE(ABORT, 'Wallet ledger is append-only'); END;
      -- Existing installations start their audit trail at the committed balance.
      INSERT INTO wallet_ledger
        (event_key, player_id, kind, delta_cents, balance_after_cents, created_at)
      SELECT 'opening:' || id, id, 'opening', balance_cents, balance_cents,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM players;
    `);
  });
}
