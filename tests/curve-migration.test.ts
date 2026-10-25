import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getPayoutCents } from '../src/engine/PumpEngine.js';
import { openDatabase } from '../src/server/database.js';
import { deriveOutcome } from '../src/server/fairness.js';
import { PumpService } from '../src/server/PumpService.js';
import { GameError } from '../src/server/errors.js';
import { seedForPop } from './helpers.js';

test('the version-three migration preserves old odd-cent rounds, order, proofs, and retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pump-curve-migration-'));
  const path = join(directory, 'pump.sqlite');
  let database = openDatabase(path);
  try {
    let service = new PumpService(database, (id) => seedForPop(id, 26, 2));
    const { playerId, newToken } = service.getSession(undefined);
    let requestId = '';
    for (const bet of [11, 99, 13]) {
      requestId = randomUUID();
      const round = service.start(playerId, { betCents: 10, requestId }).round!;
      // Build the state that the previous cent-based rules could legitimately save.
      database
        .prepare(
          'UPDATE rounds SET curve_version = 2, bet_cents = ?, pop_at_pump = 26 WHERE id = ?',
        )
        .run(bet, round.id);
      database
        .prepare(
          'UPDATE players SET balance_cents = balance_cents - ? WHERE id = ?',
        )
        .run(bet - 10, playerId);
      service.pump(playerId, { roundId: round.id, expectedVersion: 0 });
      if (bet !== 13)
        service.cashout(playerId, { roundId: round.id, expectedVersion: 1 });
    }
    const before = service.getState(playerId);
    const rowOrder = database
      .prepare('SELECT rowid, id FROM rounds ORDER BY rowid')
      .all();
    const columnNames = database
      .prepare('PRAGMA table_info(rounds)')
      .all()
      .map((row) => String(row.name))
      .join(', ');
    const sql = String(
      database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'rounds'")
        .get()!.sql,
    )
      .replace(
        /CREATE TABLE (?:IF NOT EXISTS )?rounds/i,
        'CREATE TABLE old_rounds',
      )
      .replace('IN (1, 2, 3)', 'IN (1, 2)');
    assert.ok(sql.includes('IN (1, 2)'));
    database.exec(`BEGIN; ${sql};
      INSERT INTO old_rounds (rowid, ${columnNames}) SELECT rowid, ${columnNames} FROM rounds;
      DROP TABLE rounds;
      ALTER TABLE old_rounds RENAME TO rounds;
      PRAGMA user_version = 0;
      COMMIT;`);
    database.close();

    database = openDatabase(path);
    service = new PumpService(database);
    assert.equal(service.getSession(newToken).playerId, playerId);
    assert.deepEqual(service.getState(playerId), before);
    assert.deepEqual(
      database.prepare('SELECT rowid, id FROM rounds ORDER BY rowid').all(),
      rowOrder,
    );
    assert.deepEqual(
      service.start(playerId, { betCents: 13, requestId }),
      before,
    );
    assert.throws(
      () => service.start(playerId, { betCents: 13, requestId: randomUUID() }),
      (error) => error instanceof GameError && error.statusCode === 400,
    );
    const active = before.round!;
    const pumped = service.pump(playerId, {
      roundId: active.id,
      expectedVersion: active.version,
    }).round!;
    const settled = service.cashout(playerId, {
      roundId: active.id,
      expectedVersion: pumped.version,
    }).round!;
    assert.equal(settled.curveVersion, 2);
    assert.equal(settled.payoutCents, getPayoutCents(13, 2, 2));
    assert.deepEqual(deriveOutcome(settled.id, settled.proof!.serverSeed, 2), {
      randomValueHex: settled.proof!.randomValueHex,
      popAtPump: 26,
    });
    assert.equal(
      service.start(playerId, { betCents: 20, requestId: randomUUID() }).round
        ?.curveVersion,
      3,
    );
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
});
