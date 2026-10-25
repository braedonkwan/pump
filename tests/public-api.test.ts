import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import {
  Admission,
  publicConfig,
  type PublicSettings,
} from '../src/server/admission.js';
import { openDatabase } from '../src/server/database.js';
import { PumpService } from '../src/server/PumpService.js';
import {
  PublicApi,
  PUBLIC_COOKIE,
  TRUSTED_IP_HEADER,
} from '../src/server/public-api.js';
import type { GameState, RoomState } from '../src/shared/types.js';
import { seedForPop } from './helpers.js';

function fixture(context: TestContext, settings: PublicSettings = {}) {
  const database = openDatabase(':memory:');
  context.after(() => database.close());
  const service = new PumpService(database, (id) => seedForPop(id, 26));
  let now = Date.now();
  let admission = new Admission(database, settings, () => now);
  let api = new PublicApi(database, service, admission);
  const call = (
    path = '/pump/state',
    cookie = '',
    body?: object,
    ip = 'test-ip',
  ) =>
    api.fetch(
      new Request(`https://pump.example/api${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Cookie: cookie,
          Origin: 'https://pump.example',
          [TRUSTED_IP_HEADER]: ip,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const join = async (ip?: string) => {
    const response = await call('/pump/state', '', undefined, ip);
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get('set-cookie')!.split(';')[0]!,
      state: (await response.json()) as GameState,
    };
  };
  return {
    database,
    service,
    call,
    join,
    advance(ms: number) {
      now += ms;
    },
    restart() {
      admission = new Admission(database, settings, () => now);
      api = new PublicApi(database, service, admission);
    },
  };
}

test('25 concurrent first visits are admitted and the next gets Game full without a wallet grant', async (context) => {
  const { database, call } = fixture(context);
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      call('/pump/state', '', undefined, `ip-${index}`),
    ),
  );
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    25,
  );
  assert.equal(
    responses.filter((response) => response.status === 503).length,
    15,
  );
  const full = responses.find((response) => response.status === 503)!;
  assert.equal(full.headers.get('retry-after'), '15');
  assert.equal(full.headers.get('set-cookie'), null);
  assert.match(((await full.json()) as { error: string }).error, /Game full/);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM players').get()?.total,
    25,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM wallet_ledger').get()
      ?.total,
    25,
  );
});

test('idle leases expire; duplicate tabs share a slot and heartbeats extend it', async (context) => {
  const { join, call, advance } = fixture(context, { MAX_ACTIVE_PLAYERS: '1' });
  const { cookie } = await join();
  assert.match(cookie, new RegExp(`^${PUBLIC_COOKIE}=[a-f0-9]{64}$`));
  assert.equal((await call('/pump/state', cookie)).status, 200);
  assert.equal((await call()).status, 503);
  advance(100_000);
  const heartbeat = await call('/pump/heartbeat', cookie, {});
  assert.deepEqual((await heartbeat.json()) as RoomState, {
    admitted: true,
    activePlayers: 1,
    maxPlayers: 1,
  });
  advance(100_000);
  assert.equal((await call()).status, 503);
  advance(81_000);
  assert.equal((await call()).status, 200);
});

test('recent normal requests keep a slot through a skipped idle heartbeat', async (context) => {
  const { join, call, advance } = fixture(context, { MAX_ACTIVE_PLAYERS: '1' });
  const { cookie } = await join();
  advance(80_000);
  assert.equal((await call('/pump/state', cookie)).status, 200);
  // The 120s timer skips its heartbeat because the normal request was recent.
  advance(100_000);
  assert.equal((await call()).status, 503);
  advance(80_001);
  assert.equal((await call()).status, 200);
});

test('expired players recover and cash out while full, with pump and start rejected unchanged', async (context) => {
  const { database, join, call, advance, restart } = fixture(context, {
    MAX_ACTIVE_PLAYERS: '1',
  });
  const first = await join();
  const response = await call('/pump/start', first.cookie, {
    betCents: 1000,
    requestId: randomUUID(),
  });
  const active = (await response.json()) as GameState;
  const roundId = active.round!.id;
  advance(181_000);
  const second = await join();
  restart();
  const restored = (await (
    await call('/pump/state', first.cookie)
  ).json()) as GameState;
  assert.equal(restored.room?.admitted, false);
  assert.equal(restored.round?.id, roundId);
  assert.equal(restored.wallet.balanceCents, 999_000);
  const before = database.prepare('SELECT * FROM wallet_ledger').all();
  assert.equal(
    (await call('/pump/pump', first.cookie, { roundId, expectedVersion: 0 }))
      .status,
    503,
  );
  assert.equal(
    (
      await call('/pump/start', first.cookie, {
        betCents: 1000,
        requestId: randomUUID(),
      })
    ).status,
    503,
  );
  assert.deepEqual(
    database.prepare('SELECT * FROM wallet_ledger').all(),
    before,
  );
  const cashout = { roundId, expectedVersion: 0 };
  for (let index = 0; index < 2; index++) {
    const settled = await call('/pump/cashout', first.cookie, cashout);
    assert.equal(settled.status, 200);
    assert.equal(
      ((await settled.json()) as GameState).wallet.balanceCents,
      1_000_000,
    );
  }
  assert.equal((await call('/pump/state', second.cookie)).status, 200);
  const heartbeat = await call('/pump/heartbeat', first.cookie, {});
  assert.equal(((await heartbeat.json()) as RoomState).admitted, false);
  advance(181_000);
  assert.equal(
    (
      (await (
        await call('/pump/heartbeat', first.cookie, {})
      ).json()) as RoomState
    ).admitted,
    true,
  );
});

test('session throttling survives service reconstruction and rejected actions never debit', async (context) => {
  const { database, join, call, advance, restart } = fixture(context, {
    SESSION_REQUEST_BURST: '2',
    SESSION_REQUESTS_PER_MINUTE: '60',
  });
  const { cookie } = await join();
  await call('/pump/state', cookie);
  await call('/pump/state', cookie);
  restart();
  const response = await call(
    '/pump/start',
    cookie,
    { betCents: 1000, requestId: randomUUID() },
    'different-ip',
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM rounds').get()?.total,
    0,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM wallet_ledger').get()
      ?.total,
    1,
  );
  advance(1000);
  assert.equal(
    (
      await call('/pump/start', cookie, {
        betCents: 1000,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
});

test('IP throttling covers new sessions and does not consume additional wallet grants', async (context) => {
  const { call, database, advance } = fixture(context, {
    IP_REQUEST_BURST: '2',
    IP_REQUESTS_PER_MINUTE: '60',
  });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM players').get()?.total,
    2,
  );
  advance(1000);
  assert.equal((await call()).status, 200);
});

test('public API rejects forged sessions, cross-origin posts and oversized/malformed bodies', async (context) => {
  const { database, call, join } = fixture(context);
  assert.equal(
    (await call('/pump/start', '', { betCents: 10, requestId: randomUUID() }))
      .status,
    401,
  );
  assert.equal(
    (
      await call('/pump/cashout', `${PUBLIC_COOKIE}=${'f'.repeat(64)}`, {
        roundId: 'forged',
        expectedVersion: 0,
      })
    ).status,
    401,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM players').get()?.total,
    0,
  );
  const { cookie } = await join();
  const api = new PublicApi(
    database,
    new PumpService(database),
    new Admission(database),
  );
  for (const origin of [undefined, 'null', 'https://attacker.example']) {
    const response = await api.fetch(
      new Request('https://pump.example/api/pump/start', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin } : {}),
        },
        body: '{}',
      }),
    );
    assert.equal(response.status, 403);
  }
  for (const [body, type, expected] of [
    ['{', 'application/json', 400],
    ['[]', 'application/json', 400],
    ['{}', 'text/plain', 415],
    [' '.repeat(4097), 'application/json', 413],
  ] as const) {
    const response = await api.fetch(
      new Request('https://pump.example/api/pump/start', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://pump.example',
          'Content-Type': type,
        },
        body,
      }),
    );
    assert.equal(response.status, expected);
  }
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM rounds').get()?.total,
    0,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM wallet_ledger').get()
      ?.total,
    1,
  );
});

test('public configuration rejects invalid limits rather than silently disabling protection', () => {
  for (const value of ['0', '-1', 'NaN', '1.5', 'Infinity', '9007199254740992'])
    assert.throws(() => publicConfig({ MAX_ACTIVE_PLAYERS: value }));
  assert.equal(publicConfig({}).maxPlayers, 25);
});

test('limiter storage remains bounded and expired buckets free capacity', async (context) => {
  const { database, join, call, advance } = fixture(context);
  const { cookie } = await join();
  database.exec(`WITH RECURSIVE sequence(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 4095
  ) INSERT INTO request_buckets (bucket_key, tokens, updated_at)
    SELECT 'seed:' || n, 0, ${Date.now()} FROM sequence;`);
  const rejected = await call('/pump/state', '', undefined, 'new-ip');
  assert.equal(rejected.status, 429);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM request_buckets').get()
      ?.total,
    4096,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM players').get()?.total,
    1,
  );
  advance(3_660_000);
  assert.equal((await call('/pump/state', cookie)).status, 200);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS total FROM request_buckets').get()
      ?.total,
    2,
  );
  assert.equal(
    database.prepare('SELECT balance_cents FROM players').get()?.balance_cents,
    1_000_000,
  );
});
