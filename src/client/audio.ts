import { FLIGHT_TIMING } from './flight-timing.js';

export const SOUND_EFFECTS = {
  inflate: {
    url: '/audio/balloon-inflate.ogg',
    volume: 0.4,
    durationMs: FLIGHT_TIMING.pumpMs,
  },
  pop: { url: '/audio/balloon-pop.ogg', volume: 0.44, durationMs: 540 },
  cashout: { url: '/audio/cash-out.wav', volume: 0.8, durationMs: 2200 },
  summit: { url: '/audio/top-reached.ogg', volume: 0.56, durationMs: 2200 },
} as const;
export type SoundEffect = keyof typeof SOUND_EFFECTS;

export const MUSIC_URL = '/audio/background-music.ogg';
export const MUSIC_VOLUME = 0.065;
// The music already sits below the effects; keep it audible through each cue.
export const DUCKED_MUSIC_VOLUME = MUSIC_VOLUME * 0.8;
const MUSIC_DUCK_SECONDS = 0.18;
const MUSIC_RECOVERY_SECONDS = 0.9;
const SETTINGS_KEY = 'pump.audio';

interface AudioSettings {
  music: boolean;
  effects: boolean;
}
interface PlayingEffect {
  source: AudioBufferSourceNode;
  gain: GainNode;
  endsAt: number;
}

function readSettings(): AudioSettings {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? '{}',
    );
    if (value && typeof value === 'object') {
      return {
        music: !('music' in value) || value.music !== false,
        effects: !('effects' in value) || value.effects !== false,
      };
    }
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
  return { music: true, effects: true };
}

// One audio clock keeps ducking, cancellation, and tab pauses together.
export class GameAudio {
  private readonly context: AudioContext | null;
  private readonly musicGain: GainNode | null;
  private readonly settings = readSettings();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  private music: AudioBufferSourceNode | null = null;
  private effect: PlayingEffect | null = null;
  private unlocked = false;

  constructor() {
    try {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.context.destination);
      // Decode effects ahead of the first pump, without starting playback.
      for (const cue of Object.values(SOUND_EFFECTS)) void this.load(cue.url);
    } catch {
      this.context = null;
      this.musicGain = null;
    }
  }

  get available(): boolean {
    return this.context !== null;
  }

  get musicEnabled(): boolean {
    return this.settings.music;
  }

  get effectsEnabled(): boolean {
    return this.settings.effects;
  }

  async unlock(): Promise<void> {
    if (!this.context || document.hidden) return;
    this.unlocked = true;
    try {
      await this.context.resume();
      if (this.settings.music) {
        await this.load(MUSIC_URL);
        this.startMusic();
      }
    } catch {
      // A browser may still require another gesture; gameplay remains available.
    }
  }

  setHidden(hidden: boolean): void {
    if (!this.context || !this.unlocked) return;
    if (hidden) void this.context.suspend().catch(() => {});
    else void this.unlock();
  }

  toggleMusic(): void {
    this.settings.music = !this.settings.music;
    this.saveSettings();
    if (this.settings.music) void this.unlock();
    else this.stopMusic();
  }

  toggleEffects(): void {
    this.settings.effects = !this.settings.effects;
    this.saveSettings();
    if (!this.settings.effects) this.stopEffects();
    else void this.unlock();
  }

  play(name: SoundEffect): void {
    const context = this.context;
    if (
      !context ||
      !this.unlocked ||
      context.state !== 'running' ||
      document.hidden ||
      !this.settings.effects
    )
      return;
    const cue = SOUND_EFFECTS[name];
    const buffer = this.buffers.get(cue.url);
    if (!buffer) {
      // Retry a failed load, but never replay a late cue behind its animation.
      void this.load(cue.url);
      return;
    }
    this.stopEffects();
    const source = context.createBufferSource();
    const gain = context.createGain();
    const now = context.currentTime;
    const duration = Math.min(buffer.duration, cue.durationMs / 1000);
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(cue.volume, now + 0.004);
    gain.gain.setValueAtTime(cue.volume, now + duration - 0.025);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    const effect = { source, gain, endsAt: now + duration };
    this.effect = effect;
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      if (this.effect === effect) {
        this.effect = null;
        this.updateMusicVolume();
      }
    };
    source.start(now, 0, duration);
    this.updateMusicVolume();
  }

  stopEffects(): void {
    const effect = this.effect;
    if (!effect || !this.context) return;
    this.effect = null;
    const now = this.context.currentTime;
    effect.gain.gain.cancelAndHoldAtTime(now);
    effect.gain.gain.linearRampToValueAtTime(0, now + 0.012);
    effect.source.stop(now + 0.012);
    this.updateMusicVolume();
  }

  private async load(url: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(url);
    if (cached) return cached;
    const pending = this.loading.get(url);
    if (pending) return pending;
    const context = this.context;
    if (!context) return null;
    const loading = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const buffer = await context.decodeAudioData(
          await response.arrayBuffer(),
        );
        this.buffers.set(url, buffer);
        return buffer;
      } catch {
        return null;
      } finally {
        this.loading.delete(url);
      }
    })();
    this.loading.set(url, loading);
    return loading;
  }

  private startMusic(): void {
    const context = this.context;
    const buffer = this.buffers.get(MUSIC_URL);
    if (
      !context ||
      !this.musicGain ||
      !buffer ||
      this.music ||
      !this.settings.music ||
      document.hidden ||
      context.state !== 'running'
    )
      return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.musicGain);
    source.onended = () => source.disconnect();
    this.music = source;
    source.start();
    this.updateMusicVolume();
  }

  private stopMusic(): void {
    if (!this.music || !this.context || !this.musicGain) return;
    const now = this.context.currentTime;
    this.musicGain.gain.cancelAndHoldAtTime(now);
    this.musicGain.gain.linearRampToValueAtTime(0, now + 0.12);
    this.music.stop(now + 0.12);
    this.music = null;
  }

  private updateMusicVolume(): void {
    if (!this.context || !this.musicGain || !this.music) return;
    const now = this.context.currentTime;
    const volume = this.settings.music ? MUSIC_VOLUME : 0;
    const effect = this.effect;
    const duck = effect && effect.endsAt > now;
    const target = duck ? DUCKED_MUSIC_VOLUME : volume;
    const gain = this.musicGain.gain;
    gain.cancelAndHoldAtTime(now);
    gain.linearRampToValueAtTime(
      target,
      now + (duck ? MUSIC_DUCK_SECONDS : MUSIC_RECOVERY_SECONDS),
    );
    if (duck) {
      gain.setValueAtTime(target, effect.endsAt);
      gain.linearRampToValueAtTime(
        volume,
        effect.endsAt + MUSIC_RECOVERY_SECONDS,
      );
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // The controls still work when persistence is blocked.
    }
  }
}
