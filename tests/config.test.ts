import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { getGameConfig } from '../src/server/config.js';

test('default npm launch commands keep popping enabled', () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<'dev:api' | 'start', string> };
  for (const command of ['dev:api', 'start'] as const) {
    assert.equal(
      getGameConfig({}, scripts[command].split(/\s+/)).testMode,
      false,
      `${command} must use normal gameplay`,
    );
  }
});

test('normal play keeps the normal database and session cookie', () => {
  assert.deepEqual(getGameConfig({}, []), {
    testMode: false,
    databasePath: resolve('data/pump.sqlite'),
    sessionCookieName: 'pump_session',
  });
  assert.equal(
    getGameConfig({ DATABASE_PATH: ':memory:' }, []).databasePath,
    ':memory:',
  );
});

test('testing uses its own database and session even when the normal path is configured', () => {
  for (const config of [
    getGameConfig(
      { PUMP_TEST_MODE: 'true', DATABASE_PATH: 'normal.sqlite' },
      [],
    ),
    getGameConfig({ DATABASE_PATH: 'normal.sqlite' }, ['--test-mode']),
  ]) {
    assert.equal(config.testMode, true);
    assert.equal(config.databasePath, resolve('data/pump-testing.sqlite'));
    assert.equal(config.sessionCookieName, 'pump_testing_session');
  }
});

test('the testing database can be configured independently', () => {
  const config = getGameConfig(
    {
      PUMP_TEST_MODE: 'true',
      DATABASE_PATH: 'normal.sqlite',
      PUMP_TEST_DATABASE_PATH: 'testing.sqlite',
    },
    [],
  );
  assert.equal(config.databasePath, 'testing.sqlite');
  assert.equal(
    getGameConfig(
      {
        PUMP_TEST_MODE: 'false',
        DATABASE_PATH: 'normal.sqlite',
        PUMP_TEST_DATABASE_PATH: 'testing.sqlite',
      },
      [],
    ).databasePath,
    'normal.sqlite',
  );
});
