import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import type { GameState } from '../src/shared/types.js';

test(
  'the real Workers runtime enforces concurrent admission and atomic, persistent payouts',
  { timeout: 60_000 },
  async (context) => {
    const result = await build({
      entryPoints: ['src/worker/index.ts'],
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
      external: ['cloudflare:workers', 'node:*'],
    });
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'pump-worker-test',
        modules: true,
        script: result.outputFiles[0]!.text,
        compatibilityDate: '2026-10-25',
        compatibilityFlags: ['nodejs_compat'],
        host: '127.0.0.1',
        port: 0,
        cf: false,
        log: new Log(LogLevel.ERROR),
        unsafeInspectDurableObjects: true,
        durableObjects: {
          PUMP_ROOM: { className: 'PumpRoom', useSQLite: true },
        },
        bindings: {
          MAX_ACTIVE_PLAYERS: '25',
          IP_REQUESTS_PER_MINUTE: '10000',
          IP_REQUEST_BURST: '1000',
          PUMP_TEST_MODE: 'true',
        },
        serviceBindings: {
          ASSETS: async () => new Response('static test asset'),
        },
      }),
    );
    context.after(() => runtime.dispose());
    const call = (path = '/pump/state', cookie = '', body?: object) =>
      runtime.dispatchFetch(`https://pump.example/api${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Origin: 'https://pump.example',
          Cookie: cookie,
          'CF-Connecting-IP': '192.0.2.1',
          'X-Pump-IP': randomUUID(),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const responses = await Promise.all(
      Array.from({ length: 35 }, () => call()),
    );
    const admitted = responses.filter((response) => response.status === 200);
    if (admitted.length !== 25)
      assert.fail(
        `Expected 25 admissions; got statuses ${responses.map((response) => response.status)}. First response: ${await responses[0]!.text()}`,
      );
    assert.equal(
      responses.filter((response) => response.status === 503).length,
      10,
    );
    const cookieHeader = admitted[0]!.headers.get('set-cookie')!;
    assert.match(cookieHeader, /Secure; HttpOnly; SameSite=Strict/);
    assert.equal(admitted[0]!.headers.get('cache-control'), 'no-store');
    const state = (await admitted[0]!.json()) as GameState;
    assert.equal(state.poppingDisabled, false);
    assert.equal(state.room?.activePlayers! <= 25, true);
    const cookie = cookieHeader.split(';')[0]!;
    const request = { betCents: 1000, requestId: randomUUID() };
    const starts = await Promise.all([
      call('/pump/start', cookie, request),
      call('/pump/start', cookie, request),
    ]);
    assert.deepEqual(
      starts.map((response) => response.status),
      [200, 200],
    );
    const first = (await starts[0]!.json()) as GameState;
    assert.equal(first.wallet.balanceCents, 999_000);
    assert.equal(first.round?.mode, 'normal');
    assert.equal(first.round?.proof, null);
    assert.equal(JSON.stringify(first).includes('pop_at_pump'), false);
    const roundId = first.round!.id;
    const cashout = { roundId, expectedVersion: 0 };
    const settlements = await Promise.all([
      call('/pump/cashout', cookie, cashout),
      call('/pump/cashout', cookie, cashout),
    ]);
    for (const response of settlements) {
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as GameState).wallet.balanceCents,
        1_000_000,
      );
    }
    const storage = await runtime.unsafeGetDurableObjectStorage(
      'pump-worker-test',
      'PumpRoom',
      { name: 'pump-public-v1' },
    );
    assert.equal(
      (
        await storage.exec(
          "SELECT COUNT(*) AS total FROM request_buckets WHERE bucket_key LIKE 'ip:%'",
        )
      )[0]?.total,
      1,
    );
    const ledger = await storage.exec(
      'SELECT kind, delta_cents FROM wallet_ledger WHERE round_id = ? ORDER BY id',
      roundId,
    );
    assert.deepEqual(ledger, [
      { kind: 'bet', delta_cents: -1000 },
      { kind: 'payout', delta_cents: 1000 },
    ]);
    const mismatches =
      await storage.exec(`SELECT p.id FROM players p LEFT JOIN wallet_ledger l ON l.player_id = p.id
    GROUP BY p.id HAVING p.balance_cents != COALESCE(SUM(l.delta_cents), 0)`);
    assert.deepEqual(mismatches, []);
    await storage.exec(`CREATE TRIGGER reject_bet_ledger BEFORE INSERT ON wallet_ledger
    WHEN NEW.kind = 'bet' BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END;`);
    const nextStart = { betCents: 1000, requestId: randomUUID() };
    assert.equal((await call('/pump/start', cookie, nextStart)).status, 500);
    const unchanged = (await (
      await call('/pump/state', cookie)
    ).json()) as GameState;
    assert.equal(unchanged.wallet.balanceCents, 1_000_000);
    assert.equal(unchanged.round?.id, roundId);
    await storage.exec('DROP TRIGGER reject_bet_ledger');
    const next = (await (
      await call('/pump/start', cookie, nextStart)
    ).json()) as GameState;
    await runtime.unsafeEvictDurableObject('pump-worker-test', 'PumpRoom', {
      name: 'pump-public-v1',
    });
    const restored = (await (
      await call('/pump/state', cookie)
    ).json()) as GameState;
    assert.equal(restored.round?.id, next.round?.id);
    assert.equal(restored.round?.status, 'active');
    assert.equal(restored.wallet.balanceCents, 999_000);
    assert.equal((await call()).status, 503);
    await storage.exec(
      'UPDATE player_leases SET expires_at = 0 WHERE player_id = (SELECT player_id FROM rounds WHERE id = ?)',
      next.round!.id,
    );
    const replacement = await call();
    assert.equal(replacement.status, 200);
    const recovery = (await (
      await call('/pump/state', cookie)
    ).json()) as GameState;
    assert.equal(recovery.room?.admitted, false);
    assert.equal(recovery.round?.id, next.round?.id);
    const lastRound = { roundId: next.round!.id, expectedVersion: 0 };
    assert.equal((await call('/pump/pump', cookie, lastRound)).status, 503);
    assert.equal((await call('/pump/cashout', cookie, lastRound)).status, 200);
    assert.equal((await call('/pump/cashout', cookie, lastRound)).status, 200);
    const playingCookies = admitted
      .slice(1)
      .map((response) => response.headers.get('set-cookie')!.split(';')[0]!);
    playingCookies.push(replacement.headers.get('set-cookie')!.split(';')[0]!);
    await Promise.all(
      playingCookies.map(async (playingCookie) => {
        const start = await call('/pump/start', playingCookie, {
          betCents: 10,
          requestId: randomUUID(),
        });
        assert.equal(start.status, 200);
        const round = ((await start.json()) as GameState).round!;
        const pump = await call('/pump/pump', playingCookie, {
          roundId: round.id,
          expectedVersion: 0,
        });
        assert.equal(pump.status, 200);
        const pumped = (await pump.json()) as GameState;
        if (pumped.round!.status === 'active') {
          const cashout = await call('/pump/cashout', playingCookie, {
            roundId: round.id,
            expectedVersion: 1,
          });
          assert.equal(cashout.status, 200);
        }
      }),
    );
    assert.deepEqual(
      await storage.exec(`SELECT p.id FROM players p LEFT JOIN wallet_ledger l ON l.player_id = p.id
    GROUP BY p.id HAVING p.balance_cents != COALESCE(SUM(l.delta_cents), 0)`),
      [],
    );
    assert.equal(
      await (await runtime.dispatchFetch('https://pump.example/')).text(),
      'static test asset',
    );
    // Fail object initialization to exercise the outer Worker's outage response.
    const unavailable = new Miniflare(
      convertV4MiniflareOptions({
        name: 'pump-unavailable-test',
        modules: true,
        script: result.outputFiles[0]!.text,
        compatibilityDate: '2026-10-25',
        compatibilityFlags: ['nodejs_compat'],
        host: '127.0.0.1',
        port: 0,
        cf: false,
        log: new Log(LogLevel.ERROR),
        durableObjects: {
          PUMP_ROOM: { className: 'PumpRoom', useSQLite: true },
        },
        bindings: { MAX_ACTIVE_PLAYERS: '0' },
      }),
    );
    context.after(() => unavailable.dispose());
    const outage = await unavailable.dispatchFetch(
      'https://pump.example/api/pump/state',
    );
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get('retry-after'), '30');
    assert.equal(outage.headers.get('cache-control'), 'no-store');
    assert.match(
      ((await outage.json()) as { error: string }).error,
      /temporarily unavailable/,
    );
  },
);
