import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export type SqlRow = Record<string, SQLOutputValue>;

export interface GameStatement {
  get(...values: SQLInputValue[]): SqlRow | undefined;
  all(...values: SQLInputValue[]): SqlRow[];
  run(...values: SQLInputValue[]): { changes: number | bigint };
}

// Both Node SQLite and the Durable Object adapter implement this small boundary.
export interface GameDatabase {
  prepare(sql: string): GameStatement;
  exec(sql: string): unknown;
  transactionSync?<T>(work: () => T): T;
}

const activeTransactions = new WeakSet<GameDatabase>();

export function transaction<T>(database: GameDatabase, work: () => T): T {
  // Wallet reads can refill inside a settlement. They must share its transaction.
  if (activeTransactions.has(database)) return work();
  activeTransactions.add(database);
  try {
    if (database.transactionSync) return database.transactionSync(work);
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    activeTransactions.delete(database);
  }
}
