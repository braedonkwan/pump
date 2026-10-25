import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer as createDevServer, loadConfigFromFile } from 'vite';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { PumpService } from '../src/server/PumpService.js';
import type { GameState } from '../src/shared/types.js';
import { seedForPop } from './helpers.js';

test('the dev server serves frontend modules and styles while proxying game requests', async () => {
  const database = openDatabase(':memory:');
  const api = createApp(new PumpService(database, (id) => seedForPop(id, 26)));
  let dev: Awaited<ReturnType<typeof createDevServer>> | undefined;
  try {
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'test' },
      resolve('vite.config.ts'),
    );
    assert.ok(loaded);
    // Keep the real proxy matchers; change only their target to an isolated API.
    const proxy = Object.fromEntries(
      Object.entries(loaded.config.server?.proxy ?? {}).map(
        ([context, options]) => [
          context,
          { ...(typeof options === 'string' ? {} : options), target: apiBase },
        ],
      ),
    );
    dev = await createDevServer({
      ...loaded.config,
      configFile: false,
      logLevel: 'silent',
      server: {
        ...loaded.config.server,
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        hmr: false,
        watch: null,
        proxy,
      },
    });
    await dev.listen();
    const base = `http://127.0.0.1:${(dev.httpServer!.address() as AddressInfo).port}`;
    const module = await fetch(base + '/api.ts');
    assert.equal(
      module.status,
      200,
      'The frontend api.ts module must bypass the API proxy',
    );
    assert.match(module.headers.get('content-type') ?? '', /javascript/);
    assert.match(await module.text(), /requestGameState/);
    const css = await fetch(base + '/styles.css?direct');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    const styles = await css.text();
    for (const selector of [
      '.app-header',
      '.world-viewport',
      '.controls-panel',
      '.game-dialog',
    ]) {
      assert.ok(
        styles.includes(selector),
        `Dev stylesheet includes ${selector}`,
      );
    }
    const initial = await fetch(base + '/api/pump/state');
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0]!;
    const post = async (action: string, body: object) => {
      const response = await fetch(base + '/api/pump/' + action, {
        method: 'POST',
        headers: { cookie, Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as GameState;
    };
    const started = await post('start', {
      betCents: 1000,
      requestId: randomUUID(),
    });
    const pumped = await post('pump', {
      roundId: started.round!.id,
      expectedVersion: 0,
    });
    assert.equal(pumped.round?.pumps, 1);
    const restored = await fetch(base + '/api/pump/state', {
      headers: { cookie },
    });
    assert.deepEqual(await restored.json(), pumped);
    const settled = await post('cashout', {
      roundId: pumped.round!.id,
      expectedVersion: pumped.round!.version,
    });
    assert.equal(settled.round?.status, 'cashed_out');
    assert.equal(settled.wallet.balanceCents, 1_000_100);
  } finally {
    await dev?.close();
    await new Promise<void>((resolve) => {
      api.close(() => resolve());
      api.closeAllConnections();
    });
    database.close();
  }
});
