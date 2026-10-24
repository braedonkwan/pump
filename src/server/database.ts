import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
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

    CREATE TABLE IF NOT EXISTS rounds (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      request_key TEXT NOT NULL,
      bet_cents INTEGER NOT NULL CHECK (bet_cents BETWEEN 10 AND 100000),
      pumps INTEGER NOT NULL DEFAULT 0 CHECK (pumps BETWEEN 0 AND 25),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'popped', 'cashed_out')),
      settlement_reason TEXT CHECK (settlement_reason IN ('cashout', 'limit', 'pop')),
      payout_cents INTEGER NOT NULL DEFAULT 0 CHECK (payout_cents >= 0),
      server_seed TEXT NOT NULL,
      server_seed_hash TEXT NOT NULL,
      pop_at_pump INTEGER NOT NULL CHECK (pop_at_pump BETWEEN 1 AND 26),
      created_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE (player_id, request_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_round_per_player
      ON rounds(player_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS round_history ON rounds(player_id, created_at DESC);
  `);
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
