import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { PumpService } from '../src/server/PumpService.js';
import {
  initializeGameSchema,
  initializeLedger,
} from '../src/server/schema.js';
import { sha256 } from '../src/server/fairness.js';
import {
  INITIAL_BALANCE_CENTS,
  MAX_BET_CENTS,
  MIN_BET_CENTS,
} from '../src/shared/settings.js';
import { seedForPop } from './helpers.js';

function fixture(context: TestContext, popAtPump = 26) {
  const database = openDatabase(':memory:');
  context.after(() => database.close());
  const service = new PumpService(database, (id) => seedForPop(id, popAtPump));
  const { playerId } = service.getSession(undefined);
  const entries = () =>
    database
      .prepare('SELECT * FROM wallet_ledger WHERE player_id = ? ORDER BY id')
      .all(playerId);
  const reconcile = () => {
    let balance = 0;
    for (const entry of entries()) {
      balance += Number(entry.delta_cents);
      assert.equal(entry.balance_after_cents, balance);
    }
    assert.equal(
      database
        .prepare('SELECT balance_cents FROM players WHERE id = ?')
        .get(playerId)?.balance_cents,
      balance,
    );
  };
  return { database, service, playerId, entries, reconcile };
}

test('ledger records the opening grant, one debit, and one payout across retries', (context) => {
  const { service, playerId, entries, reconcile } = fixture(context);
  const request = { betCents: 1_000, requestId: randomUUID() };
  const started = service.start(playerId, request);
  assert.deepEqual(service.start(playerId, request), started);
  service.pump(playerId, { roundId: started.round!.id, expectedVersion: 0 });
  const cashout = { roundId: started.round!.id, expectedVersion: 1 };
  const settled = service.cashout(playerId, cashout);
  assert.deepEqual(service.cashout(playerId, cashout), settled);
  assert.deepEqual(
    entries().map((entry) => entry.kind),
    ['opening', 'bet', 'payout'],
  );
  reconcile();
});

test('a failed ledger append rolls back the bet and the round together', (context) => {
  const { database, service, playerId, entries, reconcile } = fixture(context);
  database.exec(`CREATE TRIGGER reject_bet_ledger BEFORE INSERT ON wallet_ledger
    WHEN NEW.kind = 'bet' BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;`);
  const request = { betCents: 1_000, requestId: randomUUID() };
  assert.throws(() => service.start(playerId, request), /ledger unavailable/);
  assert.equal(service.getState(playerId).round, null);
  assert.equal(entries().length, 1);
  reconcile();
  database.exec('DROP TRIGGER reject_bet_ledger');
  service.start(playerId, request);
  assert.equal(entries().length, 2);
  reconcile();
});

test('a failed opening ledger entry never leaves an untracked wallet', (context) => {
  const { database, service } = fixture(context);
  database.exec(`CREATE TRIGGER reject_opening_ledger BEFORE INSERT ON wallet_ledger
    WHEN NEW.kind = 'opening' BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;`);
  assert.throws(() => service.getSession(undefined), /ledger unavailable/);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM players').get()?.total,
    1,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM wallet_ledger').get()
      ?.total,
    1,
  );
  database.exec('DROP TRIGGER reject_opening_ledger');
  const session = service.getSession(undefined);
  assert.equal(service.findSession(session.newToken), session.playerId);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM wallet_ledger').get()
      ?.total,
    2,
  );
});

test('a failed payout ledger append rolls back the settlement and can be retried', (context) => {
  const { database, service, playerId, entries, reconcile } = fixture(context);
  const round = service.start(playerId, {
    betCents: 1_000,
    requestId: randomUUID(),
  }).round!;
  const before = service.getState(playerId);
  database.exec(`CREATE TRIGGER reject_payout_ledger BEFORE INSERT ON wallet_ledger
    WHEN NEW.kind = 'payout' BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;`);
  const request = { roundId: round.id, expectedVersion: 0 };
  assert.throws(() => service.cashout(playerId, request), /ledger unavailable/);
  assert.deepEqual(service.getState(playerId), before);
  assert.equal(entries().length, 2);
  reconcile();
  database.exec('DROP TRIGGER reject_payout_ledger');
  service.cashout(playerId, request);
  service.cashout(playerId, request);
  reconcile();
  assert.equal(entries().length, 3);
});

test('losing the entire starting balance records exactly one automatic refill', (context) => {
  const { database, service, playerId, entries, reconcile } = fixture(
    context,
    1,
  );
  for (let index = 0; index < 10; index++) {
    const round = service.start(playerId, {
      betCents: 100_000,
      requestId: randomUUID(),
    }).round!;
    if (index === 9) {
      assert.equal(service.getWallet(playerId).balanceCents, 0);
      assert.equal(
        entries().filter((entry) => entry.kind === 'refill').length,
        0,
      );
      database.exec(`CREATE TRIGGER reject_refill_ledger BEFORE INSERT ON wallet_ledger
        WHEN NEW.kind = 'refill' BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;`);
      assert.throws(
        () => service.pump(playerId, { roundId: round.id, expectedVersion: 0 }),
        /ledger unavailable/,
      );
      assert.equal(service.getState(playerId).round?.status, 'active');
      assert.equal(service.getWallet(playerId).balanceCents, 0);
      reconcile();
      database.exec('DROP TRIGGER reject_refill_ledger');
    }
    service.pump(playerId, { roundId: round.id, expectedVersion: 0 });
    reconcile();
  }
  assert.equal(
    service.getState(playerId).wallet.balanceCents,
    INITIAL_BALANCE_CENTS,
  );
  service.getState(playerId);
  service.getWallet(playerId);
  assert.equal(entries().filter((entry) => entry.kind === 'refill').length, 1);
  assert.equal(entries().length, 12);
  reconcile();
});

test('a one-cent remainder refills atomically with the exact credit and allows another flight', (context) => {
  const { database, service, playerId, entries, reconcile } = fixture(
    context,
    2,
  );
  const first = service.start(playerId, {
    betCents: MIN_BET_CENTS,
    requestId: randomUUID(),
  }).round!;
  service.pump(playerId, { roundId: first.id, expectedVersion: 0 });
  service.cashout(playerId, { roundId: first.id, expectedVersion: 1 });
  assert.equal(
    service.getWallet(playerId).balanceCents,
    INITIAL_BALANCE_CENTS + 1,
  );

  for (let index = 0; index < INITIAL_BALANCE_CENTS / MAX_BET_CENTS; index++) {
    const started = service.start(playerId, {
      betCents: MAX_BET_CENTS,
      requestId: randomUUID(),
    }).round!;
    const roundId = started.id;
    service.pump(playerId, { roundId, expectedVersion: 0 });
    if (index === INITIAL_BALANCE_CENTS / MAX_BET_CENTS - 1) {
      assert.deepEqual(service.getWallet(playerId), { balanceCents: 1 });
      database.exec(`CREATE TRIGGER reject_remainder_refill BEFORE INSERT ON wallet_ledger
        WHEN NEW.kind = 'refill' BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;`);
      assert.throws(
        () => service.pump(playerId, { roundId, expectedVersion: 1 }),
        /ledger unavailable/,
      );
      assert.equal(service.getState(playerId).round?.status, 'active');
      assert.deepEqual(service.getWallet(playerId), { balanceCents: 1 });
      reconcile();
      database.exec('DROP TRIGGER reject_remainder_refill');
    }
    service.pump(playerId, { roundId, expectedVersion: 1 });
    reconcile();
  }
  const refills = entries().filter((entry) => entry.kind === 'refill');
  assert.equal(refills.length, 1);
  assert.equal(refills[0]?.delta_cents, INITIAL_BALANCE_CENTS - 1);
  assert.equal(refills[0]?.balance_after_cents, INITIAL_BALANCE_CENTS);
  assert.deepEqual(new PumpService(database).getState(playerId).wallet, {
    balanceCents: INITIAL_BALANCE_CENTS,
  });
  assert.equal(entries().filter((entry) => entry.kind === 'refill').length, 1);
  const next = service.start(playerId, {
    betCents: MIN_BET_CENTS,
    requestId: randomUUID(),
  });
  assert.equal(next.round?.status, 'active');
  assert.equal(next.wallet.balanceCents, INITIAL_BALANCE_CENTS - MIN_BET_CENTS);
  reconcile();
});

test('ledger entries cannot be edited, deleted, or reused', (context) => {
  const { database, entries, reconcile } = fixture(context);
  assert.throws(
    () => database.exec('UPDATE wallet_ledger SET delta_cents = 1'),
    /append-only/,
  );
  assert.throws(
    () => database.exec('DELETE FROM wallet_ledger'),
    /append-only/,
  );
  assert.throws(
    () =>
      database.exec(`INSERT INTO wallet_ledger
    (event_key, player_id, kind, delta_cents, balance_after_cents, created_at)
    SELECT event_key, player_id, kind, delta_cents, balance_after_cents, created_at FROM wallet_ledger`),
    /UNIQUE/,
  );
  assert.equal(entries().length, 1);
  reconcile();
});

test('existing wallets receive one honest opening balance when the ledger is introduced', (context) => {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  initializeGameSchema(database);
  const playerId = randomUUID();
  const token = 'a'.repeat(64);
  database
    .prepare(
      'INSERT INTO players (id, session_hash, balance_cents) VALUES (?, ?, ?)',
    )
    .run(playerId, sha256(token), 345);
  initializeLedger(database);
  initializeLedger(database);
  const service = new PumpService(database);
  assert.equal(service.findSession(token), playerId);
  assert.equal(service.getWallet(playerId).balanceCents, 345);
  const entries = database.prepare('SELECT * FROM wallet_ledger').all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.delta_cents, 345);
  const round = service.start(playerId, {
    betCents: 10,
    requestId: randomUUID(),
  }).round!;
  service.cashout(playerId, { roundId: round.id, expectedVersion: 0 });
  assert.equal(service.getWallet(playerId).balanceCents, 345);
});
