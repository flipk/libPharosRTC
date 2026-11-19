export class ImpairmentController {
  private lossRate: number = 0; // 0.0 to 0.5
  private direction: 'both' | 'client_tx' | 'server_tx' = 'both';

  public setLossRate(percent: number): void {
    this.lossRate = Math.max(0, Math.min(0.5, percent / 100));
  }

  public getLossRate(): number {
    return this.lossRate;
  }

  public setDirection(dir: 'both' | 'client_tx' | 'server_tx'): void {
    this.direction = dir;
  }

  public getDirection(): 'both' | 'client_tx' | 'server_tx' {
    return this.direction;
  }

  public shouldDropOutbound(): boolean {
    if (this.lossRate <= 0) return false;
    if (this.direction === 'server_tx') return false;
    return Math.random() < this.lossRate;
  }

  public shouldDropInbound(): boolean {
    if (this.lossRate <= 0) return false;
    if (this.direction === 'client_tx') return false;
    return Math.random() < this.lossRate;
  }
}
