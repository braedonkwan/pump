import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { GameActions } from '../src/client/actions.js';
import type { GameRequest } from '../src/client/api.js';
import { parseBet } from '../src/client/format.js';
import { openDatabase } from '../src/server/database.js';
import { PumpService } from '../src/server/PumpService.js';
import { MAX_PUMPS } from '../src/shared/settings.js';
import type { RoundRequest, StartRequest } from '../src/shared/types.js';
import { seedForPop } from './helpers.js';

function fixture(context: TestContext) {
  const database = openDatabase(':memory:');
  context.after(() => database.close());
  const service = new PumpService(database, (id) =>
    seedForPop(id, MAX_PUMPS + 1),
  );
  const { playerId } = service.getSession(undefined);
  const calls: string[] = [];
  const messages: string[] = [];
  let settling = false;
  const deliver: GameRequest = async (path, body) => {
    switch (path) {
      case '/pump/state':
        return service.getState(playerId);
      case '/pump/start':
        return service.start(playerId, body as StartRequest);
      case '/pump/pump':
        return service.pump(playerId, body as RoundRequest);
      case '/pump/cashout':
        return service.cashout(playerId, body as RoundRequest);
      default:
        throw new Error(`Unexpected test request: ${path}`);
    }
  };
  let transport = deliver;
  const actions = new GameActions(
    {
      changed() {},
      message: (message) => messages.push(message),
      isSettling: () => settling,
    },
    (path, body) => {
      calls.push(path);
      return transport(path, body);
    },
  );
  return {
    actions,
    calls,
    messages,
    deliver,
    setTransport(request: GameRequest) {
      transport = request;
    },
    setSettling(value: boolean) {
      settling = value;
    },
  };
}

test('client serializes rapid pumps while a response is pending', async (context) => {
  const { actions, calls, deliver, setTransport } = fixture(context);
  await actions.connect();
  await actions.start(1_000);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  setTransport(async (path, body) => {
    await pending;
    return deliver(path, body);
  });
  const first = actions.play('pump');
  await actions.play('pump');
  assert.equal(actions.busy, true);
  assert.equal(calls.filter((path) => path === '/pump/pump').length, 1);
  release();
  await first;
  assert.equal(actions.state?.round?.pumps, 1);
  assert.equal(actions.busy, false);
});

test('a lost pump response restores the committed result before another pump', async (context) => {
  const { actions, deliver, setTransport, messages } = fixture(context);
  await actions.connect();
  await actions.start(1_000);
  setTransport(async (path, body) => {
    const result = await deliver(path, body);
    if (path === '/pump/pump') throw new Error('Response lost');
    return result;
  });
  await actions.play('pump');
  assert.equal(actions.state?.round?.pumps, 1);
  assert.equal(actions.state?.round?.version, 1);
  assert.equal(actions.connected, true);
  assert.equal(messages.at(-1), 'Response lost');
  setTransport(deliver);
  await actions.play('pump');
  assert.equal(actions.state?.round?.pumps, 2);
  assert.equal(actions.state?.wallet.balanceCents, 999_000);
});

test('failed recovery blocks moves until reconnect restores authoritative state', async (context) => {
  const { actions, calls, deliver, setTransport } = fixture(context);
  await actions.connect();
  await actions.start(1_000);
  setTransport(async () => {
    throw new Error('Offline');
  });
  await actions.play('pump');
  assert.equal(actions.connected, false);
  assert.equal(actions.busy, false);
  assert.equal(actions.pendingAction, null);
  const before = calls.length;
  await actions.play('pump');
  assert.equal(calls.length, before);
  setTransport(deliver);
  await actions.connect();
  await actions.play('pump');
  assert.equal(actions.connected, true);
  assert.equal(actions.state?.round?.pumps, 1);
});

test('client refuses new flights until settlement animations finish', async (context) => {
  const { actions, calls, setSettling } = fixture(context);
  await actions.connect();
  await actions.start(1_000);
  const roundId = actions.state?.round?.id;
  await actions.play('cashout');
  setSettling(true);
  const before = calls.length;
  await actions.start(1_000);
  assert.equal(calls.length, before);
  assert.equal(actions.state?.round?.id, roundId);
  setSettling(false);
  await actions.start(1_000);
  assert.notEqual(actions.state?.round?.id, roundId);
});

test('bet input accepts only ten-cent increments within the bet limits', () => {
  assert.equal(parseBet(' 0.10 '), 10);
  assert.equal(parseBet('0.20'), 20);
  assert.equal(parseBet('1.10'), 110);
  assert.equal(parseBet('1000'), 100_000);
  for (const value of [
    '0.09',
    '0.11',
    '0.13',
    '0.99',
    '1.01',
    '1000.01',
    '1.001',
    '-1',
    '1e2',
    'NaN',
    '',
  ]) {
    assert.equal(parseBet(value), null, value);
  }
});
