import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { GameState } from '../src/shared/types.js';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { sha256 } from '../src/server/fairness.js';
import { PumpService } from '../src/server/PumpService.js';
import { seedForPop } from './helpers.js';

async function fixture(
  context: TestContext,
  options: { testMode?: boolean; cookieName?: string } = {},
) {
  const database = openDatabase(':memory:');
  const service = new PumpService(database, (id) => seedForPop(id, 2), {
    disablePopping: options.testMode ?? false,
  });
  const server = createApp(service, undefined, {
    sessionCookieName: options.cookieName,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    database.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const initial = await fetch(`${base}/api/pump/state`);
  const cookie = initial.headers.get('set-cookie')!.split(';')[0]!;
  const initialState = (await initial.json()) as GameState;
  const get = (path: string) => fetch(base + path, { headers: { cookie } });
  const post = (path: string, body: object) =>
    fetch(base + path, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { base, cookie, initial, initialState, get, post };
}

test('HTTP session, required endpoints, proof secrecy, and refresh recovery work together', async (context) => {
  const { initial, initialState, get, post } = await fixture(context);
  assert.equal(initialState.wallet.balanceCents, 1_000_000);
  assert.match(initial.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const started = await post('/api/pump/start', {
    betCents: 1_000,
    requestId: randomUUID(),
  });
  assert.equal(started.status, 200);
  const start = (await started.json()) as GameState;
  assert.equal(start.round?.proof, null);
  assert.ok(!JSON.stringify(start).includes('popAtPump'));
  const body = { roundId: start.round!.id, expectedVersion: 0 };
  const pumped = await post('/api/pump/pump', body);
  const active = (await pumped.json()) as GameState;
  assert.equal(active.round?.proof, null);
  assert.deepEqual(await (await get('/api/pump/state')).json(), active);
  assert.deepEqual(await (await get('/api/wallet')).json(), {
    balanceCents: 999_000,
  });
  assert.deepEqual(await (await get('/api/history')).json(), { rounds: [] });
  const settled = await post('/api/pump/cashout', {
    ...body,
    expectedVersion: 1,
  });
  const end = (await settled.json()) as GameState;
  assert.equal(end.round?.status, 'cashed_out');
  assert.equal(
    sha256(end.round!.proof!.serverSeed),
    start.round!.serverSeedHash,
  );
  assert.equal(end.history.length, 1);
});

test('normal and testing sessions retain separate wallets and rounds on the same host', async (context) => {
  const normal = await fixture(context);
  const testing = await fixture(context, {
    testMode: true,
    cookieName: 'pump_testing_session',
  });
  assert.ok(normal.cookie.startsWith('pump_session='));
  assert.ok(testing.cookie.startsWith('pump_testing_session='));
  const cookie = normal.cookie + '; ' + testing.cookie;
  const post = async (base: string, path: string, body: object) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as GameState;
  };
  const regular = await post(normal.base, '/api/pump/start', {
    betCents: 1000,
    requestId: randomUUID(),
  });
  let testState = await post(testing.base, '/api/pump/start', {
    betCents: 1000,
    requestId: randomUUID(),
  });
  assert.equal(regular.round?.mode, 'normal');
  assert.equal(testState.round?.mode, 'testing');
  for (let pump = 0; pump < 3; pump++)
    testState = await post(testing.base, '/api/pump/pump', {
      roundId: testState.round!.id,
      expectedVersion: testState.round!.version,
    });
  assert.equal(testState.round?.status, 'active');
  assert.equal(testState.round.nextPopProbability, 0);
  const restoredResponse = await fetch(normal.base + '/api/pump/state', {
    headers: { cookie },
  });
  assert.equal(restoredResponse.headers.get('set-cookie'), null);
  const restored = (await restoredResponse.json()) as GameState;
  assert.equal(restored.round?.id, regular.round!.id);
  assert.equal(restored.round.pumps, 0);
  assert.equal(restored.wallet.balanceCents, 999000);
  await post(testing.base, '/api/pump/cashout', {
    roundId: testState.round.id,
    expectedVersion: testState.round.version,
  });
  const stillNormal = (await (
    await fetch(normal.base + '/api/pump/state', { headers: { cookie } })
  ).json()) as GameState;
  assert.deepEqual(stillNormal, restored);
});

test('concurrent HTTP Pump and Cash Out requests cannot both succeed', async (context) => {
  const { post } = await fixture(context);
  const start = (await (
    await post('/api/pump/start', { betCents: 1_000, requestId: randomUUID() })
  ).json()) as GameState;
  const body = { roundId: start.round!.id, expectedVersion: 0 };
  const responses = await Promise.all([
    post('/api/pump/pump', body),
    post('/api/pump/cashout', body),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
});

test('concurrent HTTP cashouts return the same settlement without paying twice', async (context) => {
  const { post, get } = await fixture(context);
  const start = (await (
    await post('/api/pump/start', { betCents: 1_000, requestId: randomUUID() })
  ).json()) as GameState;
  const body = { roundId: start.round!.id, expectedVersion: 0 };
  const responses = await Promise.all([
    post('/api/pump/cashout', body),
    post('/api/pump/cashout', body),
  ]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(await responses[0]!.json(), await responses[1]!.json());
  assert.deepEqual(await (await get('/api/wallet')).json(), {
    balanceCents: 1_000_000,
  });
});

test('HTTP input validation rejects malformed payloads and cross-origin mutations', async (context) => {
  const { base, cookie, post } = await fixture(context);
  for (const betCents of ['100', 9, 11, 13, 99, 101, 10.2, null]) {
    assert.equal(
      (await post('/api/pump/start', { betCents, requestId: randomUUID() }))
        .status,
      400,
    );
  }
  const malformed = await fetch(`${base}/api/pump/start`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(malformed.status, 400);
  const wrongOrigin = await fetch(`${base}/api/pump/start`, {
    method: 'POST',
    headers: {
      cookie,
      'Content-Type': 'application/json',
      origin: 'https://other.example',
    },
    body: '{}',
  });
  assert.equal(wrongOrigin.status, 403);
  const opaqueOrigin = await fetch(`${base}/api/pump/start`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', origin: 'null' },
    body: '{}',
  });
  assert.equal(opaqueOrigin.status, 403);
  const oversized = await fetch(`${base}/api/pump/start`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(5000) }),
  });
  assert.equal(oversized.status, 413);
  const badPath = await fetch(`${base}/%zz`);
  assert.equal(badPath.status, 400);
});
