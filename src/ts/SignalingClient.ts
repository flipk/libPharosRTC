export type AnswerCallback = (sdp: string) => void;
export type ErrorCallback = (err: Error) => void;
export type CloseCallback = () => void;

export interface SignalingClientOptions {
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string = '';
  private answerCallbacks: AnswerCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private closeCallbacks: CloseCallback[] = [];
  private autoReconnect: boolean;
  private reconnectIntervalMs: number;
  private isExplicitDisconnect: boolean = false;

  constructor(options: SignalingClientOptions = {}) {
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 2000;
  }

  public connect(url: string): Promise<void> {
    this.url = url;
    this.isExplicitDisconnect = false;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        return reject(err as Error);
      }

      this.ws.onopen = () => {
        resolve();
      };

      this.ws.onerror = (_event) => {
        const err = new Error(`WebSocket error on ${url}`);
        this.errorCallbacks.forEach((cb) => cb(err));
        reject(err);
      };

      this.ws.onclose = () => {
        this.closeCallbacks.forEach((cb) => cb());
        if (this.autoReconnect && !this.isExplicitDisconnect) {
          setTimeout(() => {
            if (!this.isExplicitDisconnect) {
              this.connect(this.url).catch(() => {});
            }
          }, this.reconnectIntervalMs);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'answer' && typeof data.sdp === 'string') {
            this.answerCallbacks.forEach((cb) => cb(data.sdp));
          }
        } catch {
          // ignore non-json messages
        }
      };
    });
  }

  public sendOffer(sdp: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(JSON.stringify({ type: 'offer', sdp }));
  }

  public onAnswer(cb: AnswerCallback): void {
    this.answerCallbacks.push(cb);
  }

  public onError(cb: ErrorCallback): void {
    this.errorCallbacks.push(cb);
  }

  public onClose(cb: CloseCallback): void {
    this.closeCallbacks.push(cb);
  }

  public disconnect(): void {
    this.isExplicitDisconnect = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
