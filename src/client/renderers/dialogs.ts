import type { RoundView } from '../../shared/types.js';
import { MAX_PUMPS } from '../../shared/settings.js';
import { element } from '../dom.js';
export class GameDialogs {
  readonly proof = element<HTMLDialogElement>('#proof-dialog');
  readonly howTo = element<HTMLDialogElement>('#how-to-dialog');
  private selectedProof: RoundView | null = null;
  refresh(round: RoundView | null): void {
    if (this.proof.open && round && this.selectedProof?.id === round.id)
      this.fillProof(round);
  }
  private fillProof(round: RoundView): void {
    this.selectedProof = round;
    element('#proof-mode').textContent =
      round.mode === 'testing'
        ? 'Testing — pop outcome overridden'
        : round.mode === 'normal'
          ? 'Normal'
          : 'Not recorded';
    element('#proof-description').textContent =
      round.mode === 'testing'
        ? 'This testing round bypassed pop outcomes. The seed and pop point below describe its original outcome before the override.'
        : round.mode === 'normal'
          ? 'Your balloon’s outcome is fixed before its first pump. The seed is revealed when the round ends.'
          : 'This older round did not record whether testing was enabled. Its seed and original pop point are shown below.';
    element('#proof-round-id').textContent = round.id;
    element('#seed-hash').textContent = round.serverSeedHash;
    element('#server-seed').textContent =
      round.proof?.serverSeed ?? 'Revealed when this flight ends.';
    element('#proof-pop-point').textContent = !round.proof
      ? 'Hidden while your flight is active.'
      : round.proof.popAtPump > MAX_PUMPS
        ? `Survives all ${MAX_PUMPS} pumps.`
        : `Pump ${round.proof.popAtPump}`;
  }

  showProof(round: RoundView): void {
    this.fillProof(round);
    this.proof.showModal();
  }
}
