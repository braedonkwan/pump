import type { GameAudio } from './audio.js';
import { element } from './dom.js';

export function wireAudioControls(audio: GameAudio): void {
  const music = element<HTMLButtonElement>('#music-toggle');
  const effects = element<HTMLButtonElement>('#sound-toggle');
  const render = () => {
    for (const [button, enabled, label] of [
      [music, audio.musicEnabled, 'Music'],
      [effects, audio.effectsEnabled, 'Sound effects'],
    ] as const) {
      button.disabled = !audio.available;
      button.setAttribute('aria-pressed', String(enabled && audio.available));
      button.title = audio.available
        ? `${label}: ${enabled ? 'on' : 'off'}`
        : 'Audio is unavailable in this browser';
    }
  };
  music.addEventListener('click', () => {
    audio.toggleMusic();
    render();
  });
  effects.addEventListener('click', () => {
    audio.toggleEffects();
    render();
  });
  const unlock = (event: Event) => {
    if (
      event.target instanceof Element &&
      event.target.closest('.audio-controls')
    )
      return;
    void audio.unlock();
  };
  document.addEventListener('pointerdown', unlock, {
    capture: true,
    passive: true,
  });
  document.addEventListener('keydown', unlock, { capture: true });
  document.addEventListener('click', unlock, { capture: true });
  document.addEventListener('visibilitychange', () =>
    audio.setHidden(document.hidden),
  );
  render();
}
