import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// The HTTP/dev-server suites have separate fixtures that start the Node app.
const serverSuites = new Set(['api.test.ts', 'dev-server.test.ts']);
const tests = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts') && !serverSuites.has(name))
  .sort()
  .map((name) => `tests/${name}`);
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=spec', ...tests],
  {
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
