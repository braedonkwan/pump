import { resolve } from 'node:path';

export function getGameConfig(
  environment: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
) {
  const testMode =
    args.includes('--test-mode') || environment.PUMP_TEST_MODE === 'true';
  return {
    testMode,
    databasePath: testMode
      ? (environment.PUMP_TEST_DATABASE_PATH ??
        resolve('data/pump-testing.sqlite'))
      : (environment.DATABASE_PATH ?? resolve('data/pump.sqlite')),
    sessionCookieName: testMode ? 'pump_testing_session' : 'pump_session',
  };
}
