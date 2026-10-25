import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  GameAudio,
  MUSIC_VOLUME,
  DUCKED_MUSIC_VOLUME,
} from '../src/client/audio.js';

class FakeParam {
  value = 0;
  readonly events: { value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): void {
    this.events.push({ value, time });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ value, time });
  }
  cancelAndHoldAtTime(): void {
    this.events.length = 0;
  }
}

class FakeGain {
  gain = new FakeParam();
  connect(): void {}
  disconnect(): void {}
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  readonly starts: number[][] = [];
  readonly stops: number[] = [];
  start(...args: number[]): void {
    this.starts.push(args);
  }
  stop(time: number): void {
    this.stops.push(time);
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeContext {
  currentTime = 10;
  state = 'suspended';
  destination = {};
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  rejectResume = false;
  decodeGate: Promise<void> | null = null;
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async decodeAudioData(): Promise<AudioBuffer> {
    await this.decodeGate;
    return { duration: 3 } as AudioBuffer;
  }
  async resume(): Promise<void> {
    if (this.rejectResume) throw new Error('Gesture required');
    this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.state = 'suspended';
  }
}

function fixture(t: TestContext) {
  const context = new FakeContext();
  const document = { hidden: false };
  const stored = new Map<string, string>();
  const calls: string[] = [];
  const options = { failPop: false, blockedStorage: false };
  const globals = {
    AudioContext: function () {
      return context;
    },
    document,
    localStorage: {
      getItem: (key: string) => {
        if (options.blockedStorage) throw new Error('Storage blocked');
        return stored.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.blockedStorage) throw new Error('Storage blocked');
        stored.set(key, value);
      },
    },
    fetch: async (url: string) => {
      calls.push(url);
      return {
        ok: !(options.failPop && url.endsWith('balloon-pop.ogg')),
        arrayBuffer: async () => new ArrayBuffer(1),
      };
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { context, document, stored, calls, options };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('effects replace rapid pumps, duck music, and ignore stale completion callbacks', async (t) => {
  const { context } = fixture(t);
  const audio = new GameAudio();
  await flush();
  audio.play('inflate');
  assert.equal(context.sources.length, 0, 'No autoplay before interaction');
  await audio.unlock();
  const music = context.sources[0]!;
  assert.equal(music.loop, true);
  assert.equal(context.gains[0]!.gain.events.at(-1)?.value, MUSIC_VOLUME);
  audio.play('inflate');
  const inflate = context.sources[1]!;
  assert.deepEqual(inflate.starts[0], [10, 0, 2.18]);
  assert.equal(context.gains[0]!.gain.events[0]?.value, DUCKED_MUSIC_VOLUME);
  audio.play('pop');
  assert.equal(inflate.stops.length, 1);
  const scheduledDuck = [...context.gains[0]!.gain.events];
  inflate.onended?.();
  assert.deepEqual(context.gains[0]!.gain.events, scheduledDuck);
  audio.stopEffects();
  assert.equal(context.sources[2]!.stops.length, 1);
  assert.equal(context.gains[0]!.gain.events.at(-1)?.value, MUSIC_VOLUME);
  await audio.unlock();
  assert.equal(context.sources.filter((source) => source.loop).length, 1);
});

test('music dips gently during effects and recovers gradually without interrupting its loop', async (t) => {
  const { context } = fixture(t);
  const audio = new GameAudio();
  await audio.unlock();
  context.currentTime += 1;
  audio.play('pop');
  const [dip, hold, recovery] = context.gains[0]!.gain.events;
  assert.ok(dip && hold && recovery);
  assert.ok(dip.value >= MUSIC_VOLUME * 0.75 && dip.value < MUSIC_VOLUME);
  assert.ok(dip.time - context.currentTime >= 0.15);
  assert.equal(hold.value, dip.value);
  assert.equal(hold.time, context.currentTime + 0.54);
  assert.equal(recovery.value, MUSIC_VOLUME);
  assert.ok(recovery.time - hold.time >= 0.75);

  context.currentTime += 0.2;
  audio.play('inflate');
  const repeatedDip = context.gains[0]!.gain.events[0]!;
  assert.equal(repeatedDip.value, dip.value);
  assert.ok(repeatedDip.time - context.currentTime >= 0.15);
  assert.equal(context.sources.filter((source) => source.loop).length, 1);
  assert.equal(context.sources[0]!.stops.length, 0);
});

test('music and effects mute independently and persist across instances', async (t) => {
  const { context, stored } = fixture(t);
  const audio = new GameAudio();
  await audio.unlock();
  audio.play('cashout');
  audio.toggleEffects();
  assert.equal(context.sources[1]!.stops.length, 1);
  audio.play('pop');
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0]!.stops.length, 0);
  audio.toggleMusic();
  assert.equal(context.sources[0]!.stops.length, 1);
  await audio.unlock();
  assert.equal(context.sources.length, 2);
  assert.deepEqual(JSON.parse(stored.get('pump.audio')!), {
    music: false,
    effects: false,
  });
  const restored = new GameAudio();
  assert.equal(restored.musicEnabled, false);
  assert.equal(restored.effectsEnabled, false);
});

test('tab pauses suspend the shared clock and resume the existing loop', async (t) => {
  const { context, document } = fixture(t);
  const audio = new GameAudio();
  await audio.unlock();
  audio.play('summit');
  document.hidden = true;
  audio.setHidden(true);
  await flush();
  assert.equal(context.state, 'suspended');
  audio.play('pop');
  assert.equal(context.sources.length, 2);
  document.hidden = false;
  audio.setHidden(false);
  await flush();
  assert.equal(context.state, 'running');
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[1]!.stops.length, 0);
});

test('slow decoding drops a missed cue instead of playing behind its animation', async (t) => {
  const { context } = fixture(t);
  let release!: () => void;
  context.decodeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audio = new GameAudio();
  audio.toggleMusic();
  await audio.unlock();
  audio.play('inflate');
  assert.equal(context.sources.length, 0);
  release();
  await flush();
  assert.equal(context.sources.length, 0);
  audio.play('inflate');
  assert.equal(context.sources.length, 1);
});

test('failed assets retry without late playback and blocked storage stays usable', async (t) => {
  const { context, options, calls } = fixture(t);
  options.failPop = true;
  options.blockedStorage = true;
  const audio = new GameAudio();
  audio.toggleMusic();
  await audio.unlock();
  audio.play('pop');
  await flush();
  assert.equal(context.sources.length, 0);
  options.failPop = false;
  audio.play('pop');
  await flush();
  assert.equal(context.sources.length, 0);
  audio.play('pop');
  assert.equal(context.sources.length, 1);
  assert.ok(calls.filter((url) => url.endsWith('balloon-pop.ogg')).length >= 2);
});

test('unavailable audio and rejected autoplay never block gameplay', async (t) => {
  const { context } = fixture(t);
  context.rejectResume = true;
  const audio = new GameAudio();
  await audio.unlock();
  audio.play('pop');
  assert.equal(context.sources.length, 0);
  context.rejectResume = false;
  await audio.unlock();
  assert.equal(context.sources.length, 1);
  Reflect.deleteProperty(globalThis, 'AudioContext');
  const unsupported = new GameAudio();
  assert.equal(unsupported.available, false);
  await unsupported.unlock();
  unsupported.play('pop');
  unsupported.stopEffects();
  unsupported.toggleMusic();
  unsupported.toggleEffects();
  unsupported.setHidden(true);
});
