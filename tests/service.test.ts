import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getPayoutCents } from '../src/engine/PumpEngine.js';
import { openDatabase } from '../src/server/database.js';
import { GameError } from '../src/server/errors.js';
import { deriveOutcome, sha256 } from '../src/server/fairness.js';
import { PumpService } from '../src/server/PumpService.js';
import { seedForPop } from './helpers.js';
import {
  INITIAL_BALANCE_CENTS,
  MIN_BET_CENTS,
} from '../src/shared/settings.js';

function fixture(context: TestContext, popAtPump = 2) {
  const database = openDatabase(':memory:');
  context.after(() => database.close());
  const service = new PumpService(database, (id) => seedForPop(id, popAtPump));
  const session = service.getSession(undefined);
  const start = () =>
    service.start(session.playerId, {
      betCents: 1_000,
      requestId: randomUUID(),
    });
  return { database, service, ...session, start };
}

function conflict(error: unknown): boolean {
  return error instanceof GameError && error.statusCode === 409;
}

test('new players get $10,000 and session tokens are hashed in the database', (context) => {
  const { service, database, playerId, newToken } = fixture(context);
  assert.equal(service.getWallet(playerId).balanceCents, 1_000_000);
  assert.equal(service.getSession(newToken).playerId, playerId);
  assert.equal(
    database
      .prepare('SELECT session_hash FROM players WHERE id = ?')
      .get(playerId)?.session_hash,
    sha256(newToken!),
  );
});

test('bet debit and active-round creation are atomic and start retries do not debit again', (context) => {
  const { service, playerId, database } = fixture(context);
  const request = { betCents: 1_000, requestId: randomUUID() };
  const first = service.start(playerId, request);
  assert.equal(first.wallet.balanceCents, 999_000);
  assert.deepEqual(service.start(playerId, request), first);
  assert.throws(
    () => service.start(playerId, { ...request, betCents: 2_000 }),
    conflict,
  );
  assert.throws(
    () => service.start(playerId, { ...request, requestId: randomUUID() }),
    conflict,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM rounds').get()?.count,
    1,
  );
  assert.equal(service.getWallet(playerId).balanceCents, 999_000);
});

test('an old start retry returns the current flight without changing rounds or wallet entries', (context) => {
  const { service, playerId, database } = fixture(context);
  const request = { betCents: 1_000, requestId: randomUUID() };
  const first = service.start(playerId, request).round!;
  service.cashout(playerId, { roundId: first.id, expectedVersion: 0 });
  const current = service.start(playerId, {
    betCents: 2_000,
    requestId: randomUUID(),
  }).round!;
  const pumped = service.pump(playerId, {
    roundId: current.id,
    expectedVersion: 0,
  });
  const ledger = database
    .prepare('SELECT * FROM wallet_ledger ORDER BY id')
    .all();

  assert.deepEqual(service.start(playerId, request), pumped);
  assert.deepEqual(
    database.prepare('SELECT * FROM wallet_ledger ORDER BY id').all(),
    ledger,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM rounds').get()?.total,
    2,
  );
  assert.equal(service.getWallet(playerId).balanceCents, 998_000);
  assert.throws(
    () => service.start(playerId, { ...request, betCents: 2_000 }),
    conflict,
  );

  const settled = service.cashout(playerId, {
    roundId: current.id,
    expectedVersion: pumped.round!.version,
  });
  assert.deepEqual(service.start(playerId, request), settled);
});

test('invalid and unaffordable bets cannot create a round or change the balance', (context) => {
  const { service, database, playerId } = fixture(context);
  database
    .prepare('UPDATE players SET balance_cents = 500 WHERE id = ?')
    .run(playerId);
  assert.throws(
    () => service.start(playerId, { betCents: 1_000, requestId: randomUUID() }),
    conflict,
  );
  for (const betCents of [9, 11, 13, 99, 101, 100_001, 10.5, NaN]) {
    assert.throws(
      () => service.start(playerId, { betCents, requestId: randomUUID() }),
      GameError,
    );
  }
  assert.equal(service.getWallet(playerId).balanceCents, 500);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM rounds').get()?.count,
    0,
  );
});

test('an exception during start rolls back the wallet debit', (context) => {
  const { database, service, playerId } = fixture(context);
  const brokenService = new PumpService(database, () => {
    throw new Error('Seed unavailable');
  });
  assert.throws(
    () =>
      brokenService.start(playerId, {
        betCents: 1_000,
        requestId: randomUUID(),
      }),
    /Seed unavailable/,
  );
  assert.equal(service.getWallet(playerId).balanceCents, 1_000_000);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM rounds').get()?.count,
    0,
  );
});

test('active responses hide the seed and pop point; a settled proof reproduces the commitment', (context) => {
  const { service, start, playerId } = fixture(context);
  const round = start().round!;
  assert.equal(round.proof, null);
  assert.equal(round.serverSeedHash.length, 64);
  assert.ok(!JSON.stringify(round).includes('popAtPump'));
  const pumped = service.pump(playerId, {
    roundId: round.id,
    expectedVersion: 0,
  }).round!;
  assert.equal(pumped.status, 'active');
  assert.equal(pumped.proof, null);
  const finished = service.cashout(playerId, {
    roundId: round.id,
    expectedVersion: 1,
  }).round!;
  assert.ok(finished.proof);
  assert.equal(sha256(finished.proof.serverSeed), round.serverSeedHash);
  assert.deepEqual(deriveOutcome(round.id, finished.proof.serverSeed), {
    popAtPump: finished.proof.popAtPump,
    randomValueHex: finished.proof.randomValueHex,
  });
});

test('double-clicked cashout pays exactly once, including a retry after a new round starts', (context) => {
  const { service, playerId, start } = fixture(context);
  const round = start().round!;
  service.pump(playerId, { roundId: round.id, expectedVersion: 0 });
  const request = { roundId: round.id, expectedVersion: 1 };
  const first = service.cashout(playerId, request);
  assert.equal(first.wallet.balanceCents, 999_000 + getPayoutCents(1_000, 1));
  assert.deepEqual(service.cashout(playerId, request), first);
  const active = start();
  const balance = service.getWallet(playerId).balanceCents;
  assert.deepEqual(service.cashout(playerId, request), active);
  assert.equal(service.getWallet(playerId).balanceCents, balance);
});

test('a stale pump or cashout cannot also succeed after a pump changes the version', (context) => {
  const { service, playerId, start } = fixture(context);
  const round = start().round!;
  const request = { roundId: round.id, expectedVersion: 0 };
  service.pump(playerId, request);
  assert.throws(() => service.cashout(playerId, request), conflict);
  assert.throws(() => service.pump(playerId, request), conflict);
  assert.equal(service.getState(playerId).round?.pumps, 1);
  assert.equal(service.getWallet(playerId).balanceCents, 999_000);
});

test('a successful cashout prevents a competing pump', (context) => {
  const { service, playerId, start } = fixture(context);
  const round = start().round!;
  const request = { roundId: round.id, expectedVersion: 0 };
  service.cashout(playerId, request);
  assert.throws(() => service.pump(playerId, request), conflict);
  assert.equal(service.getWallet(playerId).balanceCents, 1_000_000);
});

test('popping loses the bet and settles without a wallet credit', (context) => {
  const { service, playerId, start } = fixture(context, 1);
  const round = start().round!;
  const result = service.pump(playerId, {
    roundId: round.id,
    expectedVersion: 0,
  });
  assert.equal(result.round?.status, 'popped');
  assert.equal(result.round.payoutCents, 0);
  assert.equal(result.wallet.balanceCents, 999_000);
  assert.equal(result.round.proof?.popAtPump, 1);
  assert.equal(result.history.length, 1);
});

test('losing the last stake refills the demo wallet once, after settlement', (context) => {
  const { service, database, playerId, newToken, start } = fixture(context);
  database
    .prepare('UPDATE players SET balance_cents = 1000 WHERE id = ?')
    .run(playerId);
  const round = start().round!;
  assert.deepEqual(service.getWallet(playerId), { balanceCents: 0 });
  const survived = service.pump(playerId, {
    roundId: round.id,
    expectedVersion: 0,
  });
  assert.equal(survived.round?.status, 'active');
  assert.deepEqual(survived.wallet, { balanceCents: 0 });

  const popped = service.pump(playerId, {
    roundId: round.id,
    expectedVersion: 1,
  });
  assert.equal(popped.round?.status, 'popped');
  assert.equal(popped.round.payoutCents, 0);
  assert.equal(popped.history[0]?.id, round.id);
  assert.deepEqual(popped.wallet, {
    balanceCents: INITIAL_BALANCE_CENTS,
    refillCents: INITIAL_BALANCE_CENTS,
  });
  assert.equal(service.getSession(newToken).playerId, playerId);
  assert.throws(
    () => service.pump(playerId, { roundId: round.id, expectedVersion: 1 }),
    conflict,
  );
  for (let read = 0; read < 3; read++)
    assert.deepEqual(service.getWallet(playerId), {
      balanceCents: INITIAL_BALANCE_CENTS,
    });
  const restored = new PumpService(database).getState(playerId);
  assert.equal(restored.wallet.balanceCents, INITIAL_BALANCE_CENTS);
  assert.deepEqual(restored.history, popped.history);
});

test('loading a wallet below the minimum refills it once while playable balances stay unchanged', (context) => {
  const { service, database, playerId } = fixture(context);
  const setBalance = database.prepare(
    'UPDATE players SET balance_cents = ? WHERE id = ?',
  );
  for (const balance of [
    MIN_BET_CENTS,
    MIN_BET_CENTS + 1,
    500,
    INITIAL_BALANCE_CENTS,
  ]) {
    setBalance.run(balance, playerId);
    assert.deepEqual(service.getWallet(playerId), { balanceCents: balance });
  }
  for (let balance = 0; balance < MIN_BET_CENTS; balance++) {
    setBalance.run(balance, playerId);
    assert.deepEqual(service.getState(playerId).wallet, {
      balanceCents: INITIAL_BALANCE_CENTS,
      refillCents: INITIAL_BALANCE_CENTS - balance,
    });
    assert.deepEqual(service.getState(playerId).wallet, {
      balanceCents: INITIAL_BALANCE_CENTS,
    });
  }
});

test('a wallet below the minimum waits for its active round before refilling', (context) => {
  const { service, database, playerId } = fixture(context);
  for (let remainder = 1; remainder < MIN_BET_CENTS; remainder++) {
    database
      .prepare('UPDATE players SET balance_cents = ? WHERE id = ?')
      .run(1_000 + remainder, playerId);
    const started = service.start(playerId, {
      betCents: 1_000,
      requestId: randomUUID(),
    });
    assert.deepEqual(started.wallet, { balanceCents: remainder });
    const roundId = started.round!.id;
    const pumped = service.pump(playerId, { roundId, expectedVersion: 0 });
    assert.deepEqual(pumped.wallet, { balanceCents: remainder });
    assert.deepEqual(service.getWallet(playerId), { balanceCents: remainder });
    const popped = service.pump(playerId, { roundId, expectedVersion: 1 });
    assert.equal(popped.round?.status, 'popped');
    assert.deepEqual(popped.wallet, {
      balanceCents: INITIAL_BALANCE_CENTS,
      refillCents: INITIAL_BALANCE_CENTS - remainder,
    });
  }
});

test('reading a playable wallet does not require a database write', (context) => {
  const { service, database, playerId } = fixture(context);
  database.exec('PRAGMA query_only = ON');
  assert.deepEqual(service.getWallet(playerId), {
    balanceCents: INITIAL_BALANCE_CENTS,
  });
});

test('cashing out a wallet below the minimum credits only the payout, with no demo refill', (context) => {
  const { service, database, playerId, start } = fixture(context);
  for (let remainder = 0; remainder < MIN_BET_CENTS; remainder++) {
    database
      .prepare('UPDATE players SET balance_cents = ? WHERE id = ?')
      .run(1_000 + remainder, playerId);
    const round = start().round!;
    assert.deepEqual(service.getWallet(playerId), { balanceCents: remainder });
    const request = { roundId: round.id, expectedVersion: 0 };
    for (let retry = 0; retry < 2; retry++) {
      assert.deepEqual(service.cashout(playerId, request).wallet, {
        balanceCents: 1_000 + remainder,
      });
    }
  }
});

test('a failed refill rolls back the pop and can be retried without extra credit', (context) => {
  const { service, database, playerId, start } = fixture(context, 1);
  database
    .prepare('UPDATE players SET balance_cents = 1000 WHERE id = ?')
    .run(playerId);
  const round = start().round!;
  database.exec(`CREATE TRIGGER reject_refill BEFORE UPDATE OF balance_cents ON players
    WHEN OLD.balance_cents = 0 AND NEW.balance_cents = ${INITIAL_BALANCE_CENTS}
    BEGIN SELECT RAISE(ABORT, 'Refill unavailable'); END;`);
  const request = { roundId: round.id, expectedVersion: 0 };
  assert.throws(() => service.pump(playerId, request), /Refill unavailable/);
  const restored = service.getState(playerId);
  assert.equal(restored.round?.status, 'active');
  assert.equal(restored.round.version, 0);
  assert.equal(restored.wallet.balanceCents, 0);
  database.exec('DROP TRIGGER reject_refill');
  assert.equal(
    service.pump(playerId, request).wallet.balanceCents,
    INITIAL_BALANCE_CENTS,
  );
  assert.equal(service.getWallet(playerId).balanceCents, INITIAL_BALANCE_CENTS);
});

test('the 25th surviving pump pays automatically once and rejects a racing cashout', (context) => {
  const { service, playerId, start } = fixture(context, 26);
  let round = start().round!;
  for (let pump = 0; pump < 25; pump++) {
    round = service.pump(playerId, {
      roundId: round.id,
      expectedVersion: round.version,
    }).round!;
  }
  assert.equal(round.status, 'cashed_out');
  assert.equal(round.settlementReason, 'limit');
  assert.equal(round.payoutCents, getPayoutCents(1_000, 25));
  assert.equal(
    service.getWallet(playerId).balanceCents,
    999_000 + round.payoutCents,
  );
  assert.throws(
    () => service.cashout(playerId, { roundId: round.id, expectedVersion: 24 }),
    conflict,
  );
  assert.throws(
    () => service.pump(playerId, { roundId: round.id, expectedVersion: 25 }),
    conflict,
  );
});

test('a round keeps its recorded rules when the server default changes', (context) => {
  const { database, service, playerId, start } = fixture(context, 1);
  const testingService = new PumpService(database, (id) => seedForPop(id, 1), {
    disablePopping: true,
  });
  let round = testingService.start(playerId, {
    betCents: 1000,
    requestId: randomUUID(),
  }).round!;
  assert.equal(round.mode, 'testing');
  assert.equal(testingService.getState(playerId).poppingDisabled, true);
  assert.equal(service.getState(playerId).poppingDisabled, false);
  assert.equal(service.getState(playerId).round?.nextPopProbability, 0);

  for (let pump = 1; pump <= 25; pump++) {
    round = service.pump(playerId, {
      roundId: round.id,
      expectedVersion: round.version,
    }).round!;
    assert.equal(round.status, pump === 25 ? 'cashed_out' : 'active');
    assert.equal(round.nextPopProbability, pump === 25 ? null : 0);
    assert.equal(round.mode, 'testing');
  }
  assert.equal(round.settlementReason, 'limit');
  assert.equal(round.payoutCents, getPayoutCents(1_000, 25));
  assert.equal(round.proof?.popAtPump, 1);
  assert.equal(service.getHistory(playerId)[0]?.mode, 'testing');
  assert.equal(
    testingService.getWallet(playerId).balanceCents,
    999_000 + round.payoutCents,
  );

  const newRound = testingService.start(playerId, {
    betCents: 1_000,
    requestId: randomUUID(),
  }).round!;
  assert.equal(newRound.nextPopProbability, 0);
  const pumped = testingService.pump(playerId, {
    roundId: newRound.id,
    expectedVersion: 0,
  }).round!;
  assert.equal(pumped.status, 'active');
  const cashedOut = testingService.cashout(playerId, {
    roundId: pumped.id,
    expectedVersion: pumped.version,
  }).round!;
  assert.equal(cashedOut.settlementReason, 'cashout');
  assert.equal(cashedOut.payoutCents, getPayoutCents(1_000, 1));

  const normalRound = start().round!;
  assert.equal(normalRound.mode, 'normal');
  assert.equal(service.getState(playerId).poppingDisabled, false);
  assert.ok(normalRound.nextPopProbability! > 0);
  assert.equal(
    testingService.pump(playerId, {
      roundId: normalRound.id,
      expectedVersion: 0,
    }).round?.status,
    'popped',
  );
});

test('testing mode survives a restart and remains attached to the revealed proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pump-test-mode-'));
  const path = join(directory, 'pump.sqlite');
  let database = openDatabase(path);
  try {
    let service = new PumpService(database, (id) => seedForPop(id, 1), {
      disablePopping: true,
    });
    const { playerId, newToken } = service.getSession(undefined);
    let round = service.start(playerId, {
      betCents: 1000,
      requestId: randomUUID(),
    }).round!;
    for (let pump = 0; pump < 3; pump++)
      round = service.pump(playerId, {
        roundId: round.id,
        expectedVersion: round.version,
      }).round!;
    database.close();
    database = openDatabase(path);
    service = new PumpService(database);
    assert.equal(service.getSession(newToken).playerId, playerId);
    assert.equal(service.getState(playerId).poppingDisabled, false);
    assert.equal(service.getState(playerId).round?.mode, 'testing');
    assert.equal(service.getState(playerId).round?.nextPopProbability, 0);
    const result = service.cashout(playerId, {
      roundId: round.id,
      expectedVersion: round.version,
    });
    assert.equal(result.round?.mode, 'testing');
    assert.equal(result.round.proof?.popAtPump, 1);
    assert.equal(result.round.payoutCents, getPayoutCents(1000, 3));
    assert.equal(result.round.nextPopProbability, null);
    assert.equal(service.getHistory(playerId)[0]?.mode, 'testing');
  } finally {
    database.close();
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
});

test('mode migration preserves results and identifies only provable old testing overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pump-mode-migration-'));
  const path = join(directory, 'pump.sqlite');
  let database = openDatabase(path);
  try {
    let normal = new PumpService(database, (id) => seedForPop(id, 1));
    const testing = new PumpService(database, (id) => seedForPop(id, 1), {
      disablePopping: true,
    });
    const { playerId } = normal.getSession(undefined);
    let bypassed = testing.start(playerId, {
      betCents: 1000,
      requestId: randomUUID(),
    }).round!;
    for (let pump = 0; pump < 3; pump++)
      bypassed = testing.pump(playerId, {
        roundId: bypassed.id,
        expectedVersion: bypassed.version,
      }).round!;
    testing.cashout(playerId, {
      roundId: bypassed.id,
      expectedVersion: bypassed.version,
    });
    const regular = normal.start(playerId, {
      betCents: 1000,
      requestId: randomUUID(),
    }).round!;
    normal.pump(playerId, { roundId: regular.id, expectedVersion: 0 });
    const wallet = normal.getWallet(playerId);
    database.exec('ALTER TABLE rounds DROP COLUMN mode');
    database.close();
    database = openDatabase(path);
    normal = new PumpService(database);
    assert.deepEqual(normal.getWallet(playerId), wallet);
    const history = normal.getHistory(playerId);
    assert.equal(
      history.find((round) => round.id === bypassed.id)?.mode,
      'testing',
    );
    assert.equal(
      history.find((round) => round.id === regular.id)?.mode,
      'unknown',
    );
    assert.equal(
      history.find((round) => round.id === regular.id)?.status,
      'popped',
    );
    assert.equal(
      history.find((round) => round.id === bypassed.id)?.proof?.popAtPump,
      1,
    );
  } finally {
    database.close();
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
});

test('players cannot see or mutate another player’s round', (context) => {
  const { service, start } = fixture(context);
  const round = start().round!;
  const other = service.getSession(undefined).playerId;
  assert.equal(service.getState(other).round, null);
  assert.deepEqual(service.getHistory(other), []);
  assert.throws(
    () => service.cashout(other, { roundId: round.id, expectedVersion: 0 }),
    (error) => error instanceof GameError && error.statusCode === 404,
  );
});

test('history contains only the most recent ten completed rounds', (context) => {
  const { service, playerId, start } = fixture(context);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const round = start().round!;
    ids.push(round.id);
    service.cashout(playerId, { roundId: round.id, expectedVersion: 0 });
  }
  start();
  assert.deepEqual(
    service.getHistory(playerId).map((round) => round.id),
    ids.slice(-10).reverse(),
  );
});

test('an existing round keeps its curve, proof and wallet through migration and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pump-test-'));
  const path = join(directory, 'pump.sqlite');
  let database = openDatabase(path);
  try {
    let service = new PumpService(database, (id) => seedForPop(id, 2, 1));
    const { playerId, newToken } = service.getSession(undefined);
    const round = service.start(playerId, {
      betCents: 1_000,
      requestId: randomUUID(),
    }).round!;
    database
      .prepare(
        'UPDATE rounds SET curve_version = 1, pop_at_pump = 2 WHERE id = ?',
      )
      .run(round.id);
    const before = service.pump(playerId, {
      roundId: round.id,
      expectedVersion: 0,
    });
    // Simulate the old schema before reopening with the new read indexes.
    database.exec(`
      DROP INDEX player_round_order;
      DROP INDEX completed_round_order;
      CREATE INDEX round_history ON rounds(player_id, created_at DESC);
      ALTER TABLE rounds DROP COLUMN curve_version;
    `);
    database.close();
    database = openDatabase(path);
    service = new PumpService(database);
    assert.equal(service.getSession(newToken).playerId, playerId);
    assert.deepEqual(service.getState(playerId), before);
    const finished = service.pump(playerId, {
      roundId: round.id,
      expectedVersion: before.round!.version,
    }).round!;
    assert.equal(finished.curveVersion, 1);
    assert.equal(finished.status, 'popped');
    assert.equal(finished.proof?.popAtPump, 2);
    assert.deepEqual(deriveOutcome(round.id, finished.proof!.serverSeed, 1), {
      popAtPump: finished.proof!.popAtPump,
      randomValueHex: finished.proof!.randomValueHex,
    });
  } finally {
    database.close();
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
});

test('zero-pump cashout refunds each stake exactly once without a wallet loss', (context) => {
  const { service, playerId } = fixture(context);
  for (const betCents of [10, 20, 100, 1000, 100_000]) {
    const start = service.start(playerId, {
      betCents,
      requestId: randomUUID(),
    });
    assert.equal(start.round?.cashoutCents, betCents);
    assert.equal(start.round?.multiplierMicros, 1_000_000);
    const request = { roundId: start.round!.id, expectedVersion: 0 };
    const result = service.cashout(playerId, request);
    assert.equal(result.round?.payoutCents, betCents);
    assert.equal(result.round?.multiplierMicros, 1_000_000);
    assert.equal(result.wallet.balanceCents, 1_000_000);
    assert.equal(
      service.cashout(playerId, request).wallet.balanceCents,
      1_000_000,
    );
  }
});

test('indexed state and history retain creation order when timestamps are identical or out of order', (context) => {
  const { service, database, playerId, start } = fixture(context);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const round = start().round!;
    ids.push(round.id);
    service.cashout(playerId, { roundId: round.id, expectedVersion: 0 });
  }
  database
    .prepare('UPDATE rounds SET created_at = ? WHERE player_id = ?')
    .run('2026-01-01T00:00:00.000Z', playerId);
  database
    .prepare('UPDATE rounds SET created_at = ? WHERE id = ?')
    .run('2099-01-01T00:00:00.000Z', ids[0]!);
  database
    .prepare('UPDATE rounds SET created_at = ? WHERE id = ?')
    .run('1900-01-01T00:00:00.000Z', ids.at(-1)!);
  assert.deepEqual(
    service.getHistory(playerId).map((round) => round.id),
    ids.slice(-10).reverse(),
  );
  assert.equal(service.getState(playerId).round?.id, ids.at(-1));
  const active = start().round!;
  database
    .prepare('UPDATE rounds SET created_at = ? WHERE id = ?')
    .run('1800-01-01T00:00:00.000Z', active.id);
  assert.equal(service.getState(playerId).round?.id, active.id);
  assert.deepEqual(
    service.getHistory(playerId).map((round) => round.id),
    ids.slice(-10).reverse(),
  );
});
