import type { SQLInputValue } from 'node:sqlite';
import type { GameDatabase, GameStatement, SqlRow } from '../server/storage.js';

interface SqlStorage {
  exec(
    query: string,
    ...bindings: (string | number | null | ArrayBuffer | ArrayBufferView)[]
  ): {
    toArray(): Record<string, string | number | null | ArrayBuffer>[];
  };
}

export class DurableDatabase implements GameDatabase {
  constructor(
    private readonly sql: SqlStorage,
    readonly transactionSync: <T>(work: () => T) => T,
  ) {}

  exec(query: string): void {
    this.sql.exec(query).toArray();
  }

  prepare(query: string): GameStatement {
    const all = (...values: SQLInputValue[]): SqlRow[] => {
      const bindings = values.map((value) => {
        if (typeof value === 'bigint')
          throw new TypeError('Use safe integer numbers for game storage.');
        return value;
      });
      return this.sql
        .exec(query, ...bindings)
        .toArray()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ]),
          ),
        );
    };
    return {
      all,
      get: (...values) => all(...values)[0],
      run: (...values) => {
        all(...values);
        // rowsWritten includes index/trigger writes; changes() counts the affected rows.
        return {
          changes: Number(
            this.sql.exec('SELECT changes() AS total').toArray()[0]?.total ?? 0,
          ),
        };
      },
    };
  }
}
