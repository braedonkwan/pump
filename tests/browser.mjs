import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createApp } from '../dist/server/server/app.js';
import { openDatabase } from '../dist/server/server/database.js';
import { PumpService } from '../dist/server/server/PumpService.js';
import { seedForPop } from './helpers.ts';

// Run `npm run test:browser` (or `npm run test:all`). CHROME_PATH overrides discovery.
// Fixtures use an ephemeral port, in-memory database, and isolated browser profile.
// Screenshots and reports are generated under ignored test-results/.
const PROTOCOL_TIMEOUT_MS = 15_000;
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((path) => path && existsSync(path));
assert.ok(
  chrome,
  'Set CHROME_PATH to a Chrome or Chromium executable to run browser checks.',
);
await mkdir('test-results', { recursive: true });
let roundNumber = 0;
const database = openDatabase(':memory:');
const serviceOptions = { disablePopping: false };
const server = createApp(
  new PumpService(
    database,
    (id) => seedForPop(id, [26, 2, 26, 26, 25, 26, 1, 1][roundNumber++] ?? 26),
    serviceOptions,
  ),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'pump-animation-'));
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { windowsHide: true, stdio: 'ignore' },
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
const report = {};
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number(
        (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(
          '\n',
        )[0],
      );
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(port, 'Chrome must be ready');
  const tabs = await (
    await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(PROTOCOL_TIMEOUT_MS),
    })
  ).json();
  socket = new WebSocket(
    tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Browser connection timed out')),
      PROTOCOL_TIMEOUT_MS,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  const failures = [];
  socket.onclose = () => {
    for (const callback of pending.values())
      callback.reject(new Error('Browser connection closed'));
    pending.clear();
  };
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    if (value.method === 'Runtime.exceptionThrown')
      exceptions.push(value.params.exceptionDetails);
    if (
      value.method === 'Network.responseReceived' &&
      value.params.response.status >= 400
    )
      failures.push({
        url: value.params.response.url,
        status: value.params.response.status,
      });
    if (!value.id) return;
    const callback = pending.get(value.id);
    if (!callback) return;
    pending.delete(value.id);
    if (value.error) callback.reject(new Error(JSON.stringify(value.error)));
    else callback.resolve(value.result);
  };
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, PROTOCOL_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression, label) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await delay(60);
    }
    console.log(
      'PAGE STATUS:',
      await evaluate(
        "({ message: document.querySelector('#message')?.textContent, status: document.querySelector('#round-status')?.textContent })",
      ),
    );
    throw new Error('Timed out: ' + label);
  }
  async function screenshot(name, fullPage = false) {
    const result = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    });
    await writeFile(
      `test-results/stage3-${name}.png`,
      Buffer.from(result.data, 'base64'),
    );
  }
  async function pump(count) {
    await evaluate("document.querySelector('#pump-button').click()");
    await waitFor(
      `Number(document.querySelector('#pump-count').textContent) === ${count} && (!document.querySelector('#pump-button').disabled || document.querySelector('#world-scene').dataset.status !== 'active')`,
      'pump ' + count,
    );
  }
  async function assertBackdropRetry(biomeId, width, height) {
    const selector = `.world-biome[data-biome="${biomeId}"]`;
    await waitFor(
      `document.querySelector('${selector}').classList.contains('is-loaded')`,
      `${biomeId} initial load`,
    );
    const failure = await evaluate(`(async () => {
      const backdrop = document.querySelector('${selector}');
      const image = backdrop.querySelector('img');
      const source = backdrop.querySelector('source');
      const previousSrc = image.currentSrc;
      // A real decode failure exercises the loader without an expected HTTP 404.
      const invalidImage = 'data:image/png;base64,aW52YWxpZC1pbWFnZS1kYXRh';
      await new Promise(resolve => {
        image.addEventListener('error', resolve, { once: true });
        if (source) source.srcset = invalidImage;
        image.src = invalidImage;
      });
      return {
        previousSrc,
        loaded: backdrop.classList.contains('is-loaded'),
        hasSrc: image.hasAttribute('src'),
        hasSrcset: Boolean(source?.hasAttribute('srcset')),
      };
    })()`);
    assert.equal(
      failure.loaded,
      false,
      'A failed backdrop clears its loaded state',
    );
    assert.equal(failure.hasSrc, false);
    assert.equal(failure.hasSrcset, false);

    // Resize invokes the normal camera/geometry path and retries the same image.
    await send('Emulation.setDeviceMetricsOverride', {
      width: width + 1,
      height,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
    await waitFor(
      `(() => { const image = document.querySelector('${selector} img'); return image.complete && image.naturalWidth > 0; })()`,
      `${biomeId} retry finishes`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('${selector}').classList.contains('is-loaded')`,
      ),
      true,
      `${biomeId} must regain its loaded state after success → failure → retry`,
    );
    assert.equal(
      await evaluate(`document.querySelector('${selector} img').currentSrc`),
      failure.previousSrc,
      'Retry restores the correct desktop or portrait asset',
    );
    await waitFor(
      `Number(getComputedStyle(document.querySelector('${selector} img')).opacity) === 1`,
      `${biomeId} recovered artwork becomes visible`,
    );
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
  }
  async function assertCompletedRisk() {
    assert.equal(
      await evaluate("document.querySelector('#pop-chance').textContent"),
      '—',
    );
    assert.equal(
      await evaluate("document.querySelector('#risk-caption').textContent"),
      'Round complete',
    );
    assert.equal(
      await evaluate("document.querySelector('#risk-fill').style.width"),
      '0%',
    );
  }
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: base });
  await waitFor(
    "document.querySelector('#start-button')?.disabled === false",
    'initial page',
  );
  await evaluate('document.fonts.ready');
  await waitFor(
    "document.querySelectorAll('.world-art[src]').length === 2 && [...document.querySelectorAll('.world-art[src]')].every(image => image.complete && image.naturalWidth > 0)",
    'initial two world scenes',
  );
  await delay(600);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.world-biome.is-loaded').length",
    ),
    2,
  );
  report.startup = await evaluate(
    "({ art: performance.getEntriesByType('resource').filter(r => r.name.includes('/art/')).map(r => ({path:new URL(r.name).pathname,bytes:r.decodedBodySize})), runningAnimations:document.getAnimations().filter(a => a.playState === 'running').length })",
  );
  assert.deepEqual(
    report.startup.art.map((r) => r.path).sort(),
    [
      '/art/world/meadow.png',
      '/art/world/cloudlands.png',
      '/art/sprites/butterfly-atlas.png',
    ].sort(),
  );
  assert.ok(report.startup.art.reduce((sum, r) => sum + r.bytes, 0) < 7000000);
  assert.ok(report.startup.runningAnimations < 40);
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.sprite-crown-whale')).backgroundImage",
    ),
    'none',
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.crown-starfall')).animationPlayState",
    ),
    'paused',
  );
  console.log(
    'PASS: only two backdrops and butterflies download initially; offscreen and summit animations are paused',
  );
  assert.ok(
    await evaluate(
      "getComputedStyle(document.querySelectorAll('.world-biome')[1]).maskImage.includes('linear-gradient')",
    ),
  );
  const spritePositions = [];
  for (let frame = 0; frame < 4; frame++) {
    spritePositions.push(
      await evaluate(
        "getComputedStyle(document.querySelector('.sprite-butterfly')).backgroundPosition",
      ),
    );
    await delay(110);
  }
  assert.ok(
    new Set(spritePositions).size > 1,
    'Sprite sheets must advance animation frames',
  );
  assert.ok(await evaluate("document.fonts.check('600 20px Manrope')"));
  assert.ok(await evaluate('document.fonts.check(\'400 16px "DM Sans"\')'));
  assert.equal(
    await evaluate(
      "Number(document.querySelector('#world-scene').dataset.cameraOffset)",
    ),
    0,
  );
  assert.equal(
    await evaluate("document.querySelector('#environment-name').textContent"),
    'The meadow',
  );
  await screenshot('pump-desktop-ground', true);
  console.log(
    'PASS: initial ground position, artwork, local fonts, desktop render',
  );
  await assertBackdropRetry('meadow', 1440, 1080);
  console.log(
    'PASS: desktop backdrop becomes visible after success, failure, and retry',
  );

  await evaluate("document.querySelector('#how-to-button').click()");
  assert.equal(
    await evaluate("document.querySelector('#how-to-dialog').open"),
    true,
  );
  await evaluate(
    "document.querySelector('#how-to-dialog [data-close-dialog]').click()",
  );
  await evaluate(
    "document.querySelector('#bet').value = '0.09'; document.querySelector('#bet-form').requestSubmit()",
  );
  assert.match(
    await evaluate("document.querySelector('#message').textContent"),
    /Enter a bet/,
  );
  for (const invalidBet of ['0.11', '0.13', '0.99', '1.01']) {
    await evaluate(
      `document.querySelector('#bet').value = '${invalidBet}'; document.querySelector('#bet-form').requestSubmit()`,
    );
    assert.match(
      await evaluate("document.querySelector('#message').textContent"),
      /\$0\.10 increments/,
    );
  }
  assert.equal(
    await evaluate(
      "fetch('/api/pump/state').then(r => r.json()).then(s => s.round)",
    ),
    null,
  );
  await evaluate(
    "document.querySelector('#bet').value = '1000.00'; document.querySelector('#bet-form').requestSubmit()",
  );
  await waitFor(
    "!document.querySelector('#pump-button').disabled",
    'round starts',
  );
  const initial = await evaluate(
    "fetch('/api/pump/state').then(response => response.json())",
  );
  let displayedRisk = Number(
    await evaluate(
      "document.querySelector('#pop-chance').textContent.replace('%', '')",
    ),
  );
  assert.equal(initial.round.proof, null);
  assert.ok(!JSON.stringify(initial).includes('popAtPump'));
  await evaluate("document.querySelector('#fairness-button').click()");
  assert.match(
    await evaluate("document.querySelector('#server-seed').textContent"),
    /Revealed when/,
  );
  await evaluate(
    "document.querySelector('#proof-dialog [data-close-dialog]').click()",
  );
  for (let count = 1; count <= 25; count++) {
    if (count === 1)
      await evaluate(
        "window.reviewHistoryChanges = 0; window.reviewGeometryReads = 0; window.reviewInitialHistory = document.querySelector('#history-body').firstElementChild; new MutationObserver(records => {window.reviewHistoryChanges += records.length}).observe(document.querySelector('#history-body'), {childList:true}); window.reviewOriginalRect = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function(...args) {if(this.id === 'world-scene') window.reviewGeometryReads++; return window.reviewOriginalRect.apply(this,args)};",
      );
    await pump(count);
    if (count < 25) {
      const nextRisk = Number(
        await evaluate(
          "document.querySelector('#pop-chance').textContent.replace('%', '')",
        ),
      );
      assert.ok(
        nextRisk > displayedRisk,
        `Displayed pop chance rises after pump ${count}`,
      );
      displayedRisk = nextRisk;
    }
    if (count === 1) {
      report.pump = await evaluate(
        "({historyChanges:window.reviewHistoryChanges, geometryReads:window.reviewGeometryReads, stableHistory:window.reviewInitialHistory === document.querySelector('#history-body').firstElementChild})",
      );
      assert.deepEqual(report.pump, {
        historyChanges: 0,
        geometryReads: 0,
        stableHistory: true,
      });
      await evaluate(
        "Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'))",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('#world-scene').getAnimations({subtree:true}).filter(a=>a.playState === 'running' && !(a instanceof CSSTransition)).length",
        ),
        0,
      );
      await evaluate(
        "delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))",
      );
    }
    if ([3, 6, 10, 14, 17, 21, 24].includes(count)) {
      await delay(1100);
      await screenshot('pump-seam-' + count);
      assert.ok(
        await evaluate(
          "new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.world-depth-far')).transform).m42 < 0",
        ),
      );
      assert.ok(
        await evaluate(
          "new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.world-depth-near')).transform).m42 > 0",
        ),
      );
    }
    await waitFor(
      "[...document.querySelectorAll('.world-art[src]')].every(image => image.complete && image.naturalWidth > 0)",
      'requested artwork at pump ' + count,
    );
    if (count === 5) {
      await delay(1150);
      await screenshot('pump-cloudlands');
      const before = await evaluate(
        "({ offset: Number(document.querySelector('#world-scene').dataset.cameraOffset), id: document.querySelector('#world-scene').dataset.status })",
      );
      await send('Page.reload');
      await waitFor(
        "!document.querySelector('#pump-button')?.disabled && document.querySelector('#pump-count')?.textContent === '05'",
        'active flight recovery',
      );
      assert.equal(
        await evaluate(
          "Number(document.querySelector('#world-scene').dataset.cameraOffset)",
        ),
        before.offset,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('#environment-name').textContent",
        ),
        'Cloudlands',
      );
      assert.equal(
        await evaluate("document.querySelector('#bet').value"),
        '1000.00',
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[data-biome=meadow] img').hasAttribute('src')",
        ),
        false,
      );
    }
    if ([8, 12, 16, 20, 23].includes(count)) {
      await delay(1150);
      await screenshot('pump-world-' + count);
    }
    if (count === 24) {
      assert.equal(
        await evaluate(
          "document.querySelector('#world-scene').hasAttribute('data-summit')",
        ),
        false,
      );
    }
    await delay(100);
  }
  assert.equal(
    await evaluate("document.querySelector('#start-button').disabled"),
    true,
  );
  const summitId = await evaluate(
    "fetch('/api/pump/state').then(r => r.json()).then(s => s.round.id)",
  );
  await evaluate("document.querySelector('#bet-form').requestSubmit()");
  assert.equal(
    await evaluate(
      "fetch('/api/pump/state').then(r => r.json()).then(s => s.round.id)",
    ),
    summitId,
  );
  await waitFor(
    "!document.querySelector('#start-button').disabled",
    'summit celebration finishes',
  );
  await assertCompletedRisk();
  assert.equal(
    await evaluate("document.querySelector('#world-scene').dataset.status"),
    'cashed_out',
  );
  assert.equal(
    await evaluate("document.querySelector('#environment-name').textContent"),
    'The Astral Crown',
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#world-scene').dataset.cameraOffset === document.querySelector('#world-scene').dataset.cameraMax",
    ),
    true,
  );
  assert.ok(
    await evaluate(
      "Math.abs(document.querySelector('#world-map').getBoundingClientRect().top - document.querySelector('#world-scene').getBoundingClientRect().top) < 1",
    ),
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.journey-segments .is-reached').length",
    ),
    25,
  );
  assert.equal(
    await evaluate("document.querySelector('#payout').textContent"),
    '$1,000,000.00',
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#world-scene').hasAttribute('data-summit')",
    ),
    true,
  );
  assert.equal(
    await evaluate("document.querySelector('#result-label').textContent"),
    'SUMMIT REACHED',
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.crown-starfall').length"),
    36,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.journey-landmarks [data-milestone]').length",
    ),
    8,
  );
  await screenshot('pump-desktop-space', true);
  const transparentAtlases =
    await evaluate(`Promise.all(['butterfly-atlas', 'sky-ray-atlas', 'crown-whale-atlas'].map(async name => {
    const image = new Image(); image.src = '/art/sprites/' + name + '.png?v=2'; await image.decode();
    if (image.width % 4 || image.height % 2 || image.width / 4 !== image.height / 2) throw new Error('Invalid sprite frame geometry: ' + name);
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3] === 0;
  }))`);
  assert.deepEqual(transparentAtlases, [true, true, true]);
  console.log(
    'PASS: eight distinct blended scenes, animated sprite frames, genuine atlas transparency',
  );

  assert.equal(
    await evaluate(
      "document.querySelector('[data-biome=meadow] img').hasAttribute('src')",
    ),
    false,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#summit-effects').hasAttribute('data-active')",
    ),
    true,
  );
  assert.ok(
    await evaluate(
      "getComputedStyle(document.querySelector('.sprite-crown-whale')).backgroundImage.includes('crown-whale-atlas')",
    ),
  );
  await send('Page.reload');
  await waitFor(
    "document.querySelector('#world-scene')?.dataset.status === 'cashed_out' && document.querySelector('#pump-count')?.textContent === '25'",
    'summit reload',
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-biome=meadow] img').hasAttribute('src')",
    ),
    false,
  );

  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [768, 1024],
    [1024, 900],
    [1440, 1080],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
    await delay(180);
    if (width < 760) {
      await waitFor(
        "document.querySelector('[data-biome=astral-crown] img').complete",
        'portrait summit',
      );
      await delay(180);
      assert.ok(
        await evaluate(
          "document.querySelector('[data-biome=astral-crown] img').currentSrc.endsWith('astral-crown-mobile.png')",
        ),
      );
    }
    assert.ok(
      await evaluate('document.documentElement.scrollWidth <= innerWidth'),
      `No page overflow at ${width}px`,
    );
    assert.ok(
      await evaluate(
        "document.querySelector('#payout').scrollWidth <= document.querySelector('#payout').clientWidth + 1",
      ),
      `Payout fits at ${width}px`,
    );
    assert.ok(
      await evaluate(
        "document.querySelector('#result-value').getBoundingClientRect().width <= document.querySelector('#result-banner').clientWidth - 30",
      ),
      `Result fits at ${width}px`,
    );
    assert.ok(
      await evaluate(
        "document.querySelector('#result-banner').getBoundingClientRect().top > document.querySelector('.multiplier-hud').getBoundingClientRect().bottom - 2",
      ),
      `HUD and result do not overlap at ${width}px`,
    );
    assert.ok(
      await evaluate(
        "Math.abs(document.querySelector('#world-map').getBoundingClientRect().top - document.querySelector('#world-scene').getBoundingClientRect().top) < 1",
      ),
      `Top stays aligned at ${width}px`,
    );
    if (width === 390) {
      await screenshot('pump-mobile-space', true);
      await assertBackdropRetry('astral-crown', width, height);
      console.log(
        'PASS: portrait backdrop becomes visible after success, failure, and retry',
      );
    }
  }
  console.log(
    'PASS: all 25 pumps, milestone changes, refresh recovery, exact top alignment, auto settlement',
  );

  await evaluate(
    "document.querySelector('#bet').value = '10.00'; document.querySelector('#bet-form').requestSubmit()",
  );
  await waitFor(
    "!document.querySelector('#pump-button').disabled && document.querySelector('#pump-count').textContent === '00'",
    'fresh round',
  );
  assert.equal(
    await evaluate(
      "Number(document.querySelector('#world-scene').dataset.cameraOffset)",
    ),
    0,
  );
  await pump(1);
  await pump(2);
  await assertCompletedRisk();
  assert.equal(
    await evaluate("document.querySelector('#start-button').disabled"),
    true,
  );
  await evaluate("document.querySelector('#bet-form').requestSubmit()");
  assert.equal(
    await evaluate("document.querySelector('#world-scene').dataset.status"),
    'popped',
  );
  await waitFor(
    "!document.querySelector('#start-button').disabled",
    'pop animation finishes',
  );
  await delay(1300);
  assert.equal(
    await evaluate("document.querySelector('#world-scene').dataset.status"),
    'popped',
  );
  assert.equal(
    await evaluate("document.querySelector('#payout').textContent"),
    '$0.00',
  );
  assert.match(
    await evaluate("document.querySelector('#result-caption').textContent"),
    /stake lost/,
  );
  await screenshot('pump-pop');
  console.log('PASS: reset to ground, pop effect, loss state');

  await evaluate("document.querySelector('#bet-form').requestSubmit()");
  await waitFor(
    "!document.querySelector('#pump-button').disabled && document.querySelector('#pump-count').textContent === '00'",
    'cashout flight',
  );
  for (let count = 1; count <= 6; count++) await pump(count);
  await evaluate("document.querySelector('#cashout-button').click()");
  await waitFor(
    "document.querySelector('#world-scene').dataset.status === 'cashed_out'",
    'manual cashout',
  );
  await assertCompletedRisk();
  assert.equal(
    await evaluate("document.querySelector('#result-label').textContent"),
    'PAYOUT SECURED',
  );
  assert.equal(
    await evaluate("document.querySelector('#start-button').disabled"),
    true,
  );
  const cashoutId = await evaluate(
    "fetch('/api/pump/state').then(r => r.json()).then(s => s.round.id)",
  );
  await evaluate("document.querySelector('#bet-form').requestSubmit()");
  assert.equal(
    await evaluate(
      "fetch('/api/pump/state').then(r => r.json()).then(s => s.round.id)",
    ),
    cashoutId,
  );
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await waitFor(
    "!document.querySelector('#start-button').disabled",
    'reduced motion releases cancelled animations',
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#scene-particles').children.length",
    ),
    0,
  );
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  assert.equal(
    await evaluate("document.querySelectorAll('#history-body tr').length"),
    3,
  );
  await evaluate("document.querySelector('.round-id-button').click()");
  assert.equal(
    await evaluate("document.querySelector('#server-seed').textContent.length"),
    64,
  );
  await evaluate(
    "document.querySelector('#proof-dialog [data-close-dialog]').click()",
  );
  console.log('PASS: manual cashout, wallet, history, seed disclosure');

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await delay(300);
  await evaluate("document.querySelector('#bet-form').requestSubmit()");
  await waitFor(
    "!document.querySelector('#pump-button').disabled && document.querySelector('#pump-count').textContent === '00'",
    'mobile flight',
  );
  for (let count = 1; count <= 10; count++) await pump(count);
  await delay(1200);
  await evaluate('window.scrollTo(0, 0)');
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#round-actions')).position",
    ),
    'fixed',
  );
  assert.ok(
    await evaluate('document.documentElement.scrollWidth <= innerWidth'),
  );
  assert.ok(
    await evaluate(
      "document.querySelector('#pump-button').getBoundingClientRect().bottom <= innerHeight",
    ),
  );
  await screenshot('pump-mobile-flight', true);
  console.log('PASS: mobile camera, fixed action dock, no horizontal overflow');

  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await delay(50);
  await pump(11);
  await delay(50);
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.balloon-bob')).animationName",
    ),
    'none',
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#world-map')).transitionDuration",
    ),
    '0s',
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.sprite-butterfly')).animationName",
    ),
    'none',
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.sprite-sky-ray')).animationName",
    ),
    'none',
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.sprite-crown-whale')).animationName",
    ),
    'none',
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.crown-starfall')).animationName",
    ),
    'none',
  );
  console.log('PASS: reduced motion preference');
  await evaluate("document.querySelector('#cashout-button').click()");
  await waitFor(
    "document.querySelector('#world-scene').dataset.status === 'cashed_out'",
    'finish fourth flight',
  );
  await evaluate("document.querySelector('#bet-form').requestSubmit()");
  await waitFor(
    "!document.querySelector('#pump-button').disabled && document.querySelector('#pump-count').textContent === '00'",
    '25th-pump pop fixture',
  );
  for (let count = 1; count <= 25; count++) await pump(count);
  assert.equal(
    await evaluate("document.querySelector('#world-scene').dataset.status"),
    'popped',
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#world-scene').hasAttribute('data-summit')",
    ),
    false,
  );
  assert.equal(
    await evaluate("document.querySelector('#result-label').textContent"),
    'FLIGHT ENDED',
  );
  console.log('PASS: a pop on pump 25 never triggers a summit win');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  const beforeRefund = await evaluate(
    "fetch('/api/pump/state').then(r => r.json()).then(s => s.wallet.balanceCents)",
  );
  await evaluate(
    "document.querySelector('#bet').value = '0.10'; document.querySelector('#bet-form').requestSubmit()",
  );
  await waitFor(
    "!document.querySelector('#cashout-button').disabled && document.querySelector('#pump-count').textContent === '00'",
    'minimum-stake refund fixture',
  );
  assert.equal(
    await evaluate("document.querySelector('#cashout-value').textContent"),
    '$0.10',
  );
  await evaluate("document.querySelector('#cashout-button').click()");
  await waitFor(
    "document.querySelector('#world-scene').dataset.status === 'cashed_out'",
    'zero-pump refund',
  );
  await assertCompletedRisk();
  assert.equal(
    await evaluate(
      "fetch('/api/pump/state').then(r => r.json()).then(s => s.wallet.balanceCents)",
    ),
    beforeRefund,
  );
  assert.equal(
    await evaluate("document.querySelector('#start-button').disabled"),
    true,
  );
  await waitFor(
    "!document.querySelector('#start-button').disabled",
    'refund cashout animation finishes',
  );
  console.log(
    'PASS: minimum-stake zero-pump refund, restart guards, and animation-cancellation recovery',
  );
  serviceOptions.disablePopping = true;
  await send('Page.reload');
  await waitFor(
    "document.querySelector('#start-button')?.disabled === false",
    'testing default loaded',
  );
  await evaluate(
    "document.querySelector('#bet').value = '0.10'; document.querySelector('#bet-form').requestSubmit()",
  );
  await waitFor(
    "!document.querySelector('#pump-button').disabled",
    'testing round starts',
  );
  for (let count = 1; count <= 3; count++) await pump(count);
  serviceOptions.disablePopping = false;
  await send('Page.reload');
  await waitFor(
    "!document.querySelector('#pump-button')?.disabled && document.querySelector('#pump-count')?.textContent === '03'",
    'testing round restored under normal defaults',
  );
  assert.equal(
    await evaluate("document.querySelector('#pop-chance').textContent"),
    '0.00%',
  );
  assert.match(
    await evaluate("document.querySelector('#rtp-label').textContent"),
    /TEST ROUND/,
  );
  await pump(4);
  serviceOptions.disablePopping = true;
  await evaluate("document.querySelector('#cashout-button').click()");
  await waitFor(
    "document.querySelector('#world-scene').dataset.status === 'cashed_out'",
    'testing cashout',
  );
  await assertCompletedRisk();
  await waitFor(
    "!document.querySelector('#start-button').disabled",
    'testing animation finishes',
  );
  const testId = await evaluate(
    "fetch('/api/pump/state').then(r=>r.json()).then(s=>s.round.id)",
  );
  serviceOptions.disablePopping = false;
  await evaluate("document.querySelector('#bet-form').requestSubmit()");
  await waitFor(
    "!document.querySelector('#pump-button').disabled && document.querySelector('#pump-count').textContent === '00'",
    'normal round after testing',
  );
  assert.equal(
    await evaluate("document.querySelector('#rtp-label').textContent"),
    '97% RTP',
  );
  await pump(1);
  await assertCompletedRisk();
  await evaluate("document.querySelectorAll('.round-id-button')[1].click()");
  assert.equal(
    await evaluate("document.querySelector('#proof-round-id').textContent"),
    testId,
  );
  assert.match(
    await evaluate("document.querySelector('#proof-mode').textContent"),
    /Testing/,
  );
  assert.match(
    await evaluate("document.querySelector('#proof-description').textContent"),
    /testing round bypassed/,
  );
  assert.equal(
    await evaluate("document.querySelector('#proof-pop-point').textContent"),
    'Pump 1',
  );
  await evaluate(
    "document.querySelector('#proof-dialog [data-close-dialog]').click()",
  );
  console.log(
    'PASS: recorded testing mode controls restored rounds and history proofs; completed risk stays cleared in both modes',
  );
  assert.deepEqual(exceptions, []);
  assert.deepEqual(failures, []);
  console.log('PASS: no JavaScript exceptions or failed requests');
  await writeFile(
    'test-results/stage3-browser-results.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (browser.exitCode === null && browser.signalCode === null) {
    const stopped = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill();
    await stopped;
  }
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  database.close();
  const profileRelative = relative(tmpdir(), profile);
  assert.ok(
    !profileRelative.startsWith('..') &&
      !isAbsolute(profileRelative) &&
      profileRelative.startsWith('pump-animation-'),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
