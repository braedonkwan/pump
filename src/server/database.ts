import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIN_BET_CENTS, MAX_BET_CENTS, MAX_PUMPS } from '../shared/settings.js';

function roundsTableSQL(table: string): string {
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

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  const existingRounds = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rounds'",
    )
    .get();
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL UNIQUE,
      balance_cents INTEGER NOT NULL DEFAULT 1000000
        CHECK (balance_cents >= 0 AND balance_cents <= 9007199254740991)
    );

    ${roundsTableSQL('rounds')}

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_round_per_player
      ON rounds(player_id) WHERE status = 'active';
    -- SQLite appends rowid to these indexes, matching newest-created ordering.
    CREATE INDEX IF NOT EXISTS player_round_order ON rounds(player_id);
    CREATE INDEX IF NOT EXISTS completed_round_order
      ON rounds(player_id) WHERE status != 'active';
    DROP INDEX IF EXISTS round_history;
  `);
  const columns = database.prepare('PRAGMA table_info(rounds)').all();
  if (!columns.some((column) => column.name === 'curve_version')) {
    database.exec(
      'ALTER TABLE rounds ADD COLUMN curve_version INTEGER NOT NULL DEFAULT 1 CHECK (curve_version IN (1, 2, 3))',
    );
  }
  if (!columns.some((column) => column.name === 'mode')) {
    database.exec(`
      ALTER TABLE rounds ADD COLUMN mode TEXT NOT NULL DEFAULT 'unknown'
        CHECK (mode IN ('normal', 'testing', 'unknown'));
      -- Only infer testing when the stored result proves an override occurred.
      UPDATE rounds SET mode = 'testing'
        WHERE pumps > pop_at_pump OR (pumps = pop_at_pump AND status != 'popped');
    `);
  }
  const schemaVersion = Number(
    database.prepare('PRAGMA user_version').get()?.user_version ?? 0,
  );
  if (existingRounds && schemaVersion < 1) {
    // Rebuild the old CHECK constraint atomically, preserving creation order and all proofs.
    transaction(database, () => {
      database.exec(`${roundsTableSQL('rounds_upgrade')}
        INSERT INTO rounds_upgrade (rowid, id, player_id, request_key, curve_version, mode,
          bet_cents, pumps, version, status, settlement_reason, payout_cents,
          server_seed, server_seed_hash, pop_at_pump, created_at, ended_at)
        SELECT rowid, id, player_id, request_key, curve_version, mode,
          bet_cents, pumps, version, status, settlement_reason, payout_cents,
          server_seed, server_seed_hash, pop_at_pump, created_at, ended_at FROM rounds;
        DROP TABLE rounds;
        ALTER TABLE rounds_upgrade RENAME TO rounds;
        CREATE UNIQUE INDEX one_active_round_per_player ON rounds(player_id) WHERE status = 'active';
        CREATE INDEX player_round_order ON rounds(player_id);
        CREATE INDEX completed_round_order ON rounds(player_id) WHERE status != 'active';
        PRAGMA user_version = 1;
      `);
    });
  } else if (schemaVersion < 1) database.exec('PRAGMA user_version = 1');
  return database;
}

export function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
