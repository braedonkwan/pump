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

test('invalid and unaffordable bets cannot create a round or change the balance', (context) => {
  const { service, database, playerId } = fixture(context);
  database
    .prepare('UPDATE players SET balance_cents = 500 WHERE id = ?')
    .run(playerId);
  assert.throws(
    () => service.start(playerId, { betCents: 1_000, requestId: randomUUID() }),
    conflict,
  );
  for (const betCents of [9, 100_001, 10.5, NaN]) {
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
  start();
  const balance = service.getWallet(playerId).balanceCents;
  service.cashout(playerId, request);
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
  assert.equal(service.getWallet(playerId).balanceCents, 999_970);
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

test('the testing override makes existing and new rounds safe without changing payouts or normal mode', (context) => {
  const { database, service, playerId, start } = fixture(context, 1);
  let round = start().round!;
  const testingService = new PumpService(database, (id) => seedForPop(id, 1), {
    disablePopping: true,
  });
  assert.equal(testingService.getState(playerId).poppingDisabled, true);
  assert.equal(testingService.getState(playerId).round?.nextPopProbability, 0);

  for (let pump = 1; pump <= 25; pump++) {
    round = testingService.pump(playerId, {
      roundId: round.id,
      expectedVersion: round.version,
    }).round!;
    assert.equal(round.status, pump === 25 ? 'cashed_out' : 'active');
    assert.equal(round.nextPopProbability, pump === 25 ? null : 0);
  }
  assert.equal(round.settlementReason, 'limit');
  assert.equal(round.payoutCents, getPayoutCents(1_000, 25));
  assert.equal(round.proof?.popAtPump, 1);
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
  assert.equal(service.getState(playerId).poppingDisabled, false);
  assert.ok(normalRound.nextPopProbability! > 0);
  assert.equal(
    service.pump(playerId, {
      roundId: normalRound.id,
      expectedVersion: 0,
    }).round?.status,
    'popped',
  );
});

test('restoring popping after a testing round passed its pop point ends on the next pump', (context) => {
  const { database, service, playerId, start } = fixture(context, 1);
  const testingService = new PumpService(database, undefined, {
    disablePopping: true,
  });
  let round = start().round!;
  for (let pump = 0; pump < 3; pump++) {
    round = testingService.pump(playerId, {
      roundId: round.id,
      expectedVersion: round.version,
    }).round!;
  }
  assert.equal(round.status, 'active');
  assert.equal(service.getState(playerId).round?.nextPopProbability, 1);
  const result = service.pump(playerId, {
    roundId: round.id,
    expectedVersion: round.version,
  });
  assert.equal(result.round?.status, 'popped');
  assert.equal(result.round.pumps, 4);
  assert.equal(result.round.payoutCents, 0);
  assert.equal(result.wallet.balanceCents, 999_000);
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

test('an abandoned round and wallet survive a database close and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pump-test-'));
  const path = join(directory, 'pump.sqlite');
  let database = openDatabase(path);
  try {
    let service = new PumpService(database, (id) => seedForPop(id, 2));
    const { playerId, newToken } = service.getSession(undefined);
    const round = service.start(playerId, {
      betCents: 1_000,
      requestId: randomUUID(),
    }).round!;
    const before = service.pump(playerId, {
      roundId: round.id,
      expectedVersion: 0,
    });
    database.close();
    database = openDatabase(path);
    service = new PumpService(database);
    assert.equal(service.getSession(newToken).playerId, playerId);
    assert.deepEqual(service.getState(playerId), before);
  } finally {
    database.close();
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
});
