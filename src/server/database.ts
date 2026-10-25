import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeGameSchema,
  initializeLedger,
  roundsTableSQL,
} from './schema.js';
import { transaction } from './storage.js';
export { transaction } from './storage.js';

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
  `);
  initializeGameSchema(database);
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
  initializeLedger(database);
  return database;
}
