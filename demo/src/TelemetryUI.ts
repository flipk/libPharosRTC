import { ArqStats } from '../../src/ts/ArqEngine';

export interface ExtendedTelemetryStats extends ArqStats {
  fecParityTx: number;
  fecParityRx: number;
  fecRecoveries: number;
  appMtu: number;
}

export class TelemetryUI {
  private statTxEl = document.getElementById('statTx') as HTMLElement;
  private statRxEl = document.getElementById('statRx') as HTMLElement;
  private statRetxEl = document.getElementById('statRetx') as HTMLElement;
  private statRetxRatioEl = document.getElementById('statRetxRatio') as HTMLElement;

  private statRttEl = document.getElementById('statRtt') as HTMLElement;
  private statRtoEl = document.getElementById('statRto') as HTMLElement;
  private statLossEl = document.getElementById('statLoss') as HTMLElement;
  private statMtuEl = document.getElementById('statMtu') as HTMLElement;

  private statParityFramesEl = document.getElementById('statParityFrames') as HTMLElement;
  private statParityRecoveriesEl = document.getElementById('statParityRecoveries') as HTMLElement;

  public update(stats: ExtendedTelemetryStats): void {
    if (this.statTxEl) this.statTxEl.textContent = stats.txFrames.toLocaleString();
    if (this.statRxEl) this.statRxEl.textContent = stats.rxFrames.toLocaleString();
    if (this.statRetxEl) this.statRetxEl.textContent = stats.retransmissions.toLocaleString();

    const ratio = stats.txFrames > 0 ? (stats.retransmissions / stats.txFrames) * 100 : 0;
    if (this.statRetxRatioEl) this.statRetxRatioEl.textContent = `${ratio.toFixed(1)}%`;

    if (this.statRttEl) this.statRttEl.textContent = `${stats.smoothedRttMs.toFixed(1)} ms`;
    if (this.statRtoEl) this.statRtoEl.textContent = `${stats.currentRtoMs.toFixed(1)} ms`;

    const lossPct = stats.estimatedPacketLoss * 100;
    if (this.statLossEl) this.statLossEl.textContent = `${lossPct.toFixed(1)}%`;
    if (this.statMtuEl) this.statMtuEl.textContent = `${stats.appMtu} B`;

    if (this.statParityFramesEl) {
      this.statParityFramesEl.textContent = `${stats.fecParityTx} / ${stats.fecParityRx}`;
    }

    if (this.statParityRecoveriesEl) {
      this.statParityRecoveriesEl.textContent = stats.fecRecoveries.toString();
    }
  }
}
